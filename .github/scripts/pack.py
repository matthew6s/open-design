#!/usr/bin/env python3
"""Compose exact content and Shell documents around native Terminal distributions."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
from typing import Any


CHANNELS = {"betahyx", "previewhyx"}
DIGEST = re.compile(r"^[a-f0-9]{64}$")
SOURCE_COMMIT = re.compile(r"^[a-f0-9]{40}$")
TARGET = re.compile(r"^[a-z0-9]+(?:-[a-z0-9]+)*$")
VERSION = re.compile(r"^\d+\.\d+\.\d+(?:-[0-9a-z]+(?:[.-][0-9a-z]+)*)?$")


def canonical_bytes(value: Any) -> bytes:
    return (json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True) + "\n").encode()


def read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise SystemExit(f"JSON document must be an object: {path}")
    return value


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(canonical_bytes(value))


def described(path: Path) -> dict[str, Any]:
    body = path.read_bytes()
    return {"file": str(path.resolve()), "sha256": hashlib.sha256(body).hexdigest(), "size": len(body)}


def checked_description(value: dict[str, Any], label: str, override: str | None = None) -> Path:
    path = Path(override or str(value.get("file", ""))).resolve()
    actual = described(path)
    if actual["sha256"] != value.get("sha256") or actual["size"] != value.get("size"):
        raise SystemExit(f"{label} binding verification failed: {path}")
    return path


def require_release(value: dict[str, Any]) -> None:
    channel = value.get("channel")
    release = value.get("releaseVersion", "")
    if channel not in CHANNELS:
        raise SystemExit("channel must be betahyx or previewhyx")
    if re.fullmatch(rf"\d+\.\d+\.\d+-{channel}\.\d+", str(release)) is None:
        raise SystemExit("releaseVersion does not belong to channel")
    if not SOURCE_COMMIT.fullmatch(str(value.get("sourceCommit", ""))):
        raise SystemExit("sourceCommit must be a full lowercase SHA")
    if not VERSION.fullmatch(str(value.get("standaloneVersion", ""))):
        raise SystemExit("invalid standaloneVersion")
    if not VERSION.fullmatch(str(value.get("shellVersion", ""))):
        raise SystemExit("invalid shellVersion")
    if not isinstance(value.get("publishedAt"), str) or "T" not in value["publishedAt"]:
        raise SystemExit("publishedAt must be an ISO timestamp")
    if not re.fullmatch(r"https?://[^\s]+", str(value.get("artifactBaseUrl", ""))):
        raise SystemExit("artifactBaseUrl must use HTTP(S)")


def signing_keys() -> list[dict[str, str]]:
    keys: list[dict[str, str]] = []
    for suffix in ("", "_NEXT"):
        key_id = os.environ.get(f"OD_EXACT_SIGNING_KEY_ID{suffix}", "")
        private_key = os.environ.get(f"OD_EXACT_ED25519_PRIVATE_KEY{suffix}", "")
        key_file = os.environ.get(f"OD_EXACT_ED25519_PRIVATE_KEY_FILE{suffix}", "")
        if not private_key and key_file:
            private_key = Path(key_file).read_text(encoding="utf-8")
        if key_id or private_key:
            if not re.fullmatch(r"[a-z0-9][a-z0-9._-]{0,63}", key_id) or not private_key:
                raise SystemExit(f"incomplete or invalid signing key pair: {suffix or 'primary'}")
            keys.append({"keyId": key_id, "privateKey": private_key})
    if not keys or len({item["keyId"] for item in keys}) != len(keys):
        raise SystemExit("at least one unique exact signing key is required")
    return keys


CRYPTO_SCRIPT = r"""
const {createPublicKey, sign, verify} = require('node:crypto');
let source = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => source += chunk);
process.stdin.on('end', () => {
  const input = JSON.parse(source);
  const payload = Buffer.from(input.payload, 'base64');
  const keys = input.keys.map(({keyId, privateKey}) => ({
    keyId,
    privateKey,
    publicKey: createPublicKey(privateKey).export({type: 'spki', format: 'pem'}),
  }));
  const result = {
    keys: keys.map(({keyId, publicKey}) => ({keyId, publicKey})),
    signatures: keys.map(({keyId, privateKey}) => ({algorithm: 'Ed25519', keyId, value: sign(null, payload, privateKey).toString('base64')})),
  };
  if (input.verify) {
    result.verified = input.verify.some(signature => {
      const key = keys.find(candidate => candidate.keyId === signature.keyId);
      return key && signature.algorithm === 'Ed25519' && verify(null, payload, key.publicKey, Buffer.from(signature.value, 'base64'));
    });
  }
  process.stdout.write(JSON.stringify(result));
});
"""


def crypto(value: Any, keys: list[dict[str, str]], verify_signatures: Any = None) -> dict[str, Any]:
    payload = {
        "payload": base64.b64encode(canonical_bytes(value)).decode(),
        "keys": keys,
        **({"verify": verify_signatures} if verify_signatures is not None else {}),
    }
    result = subprocess.run(
        ["node", "-e", CRYPTO_SCRIPT],
        input=json.dumps(payload),
        text=True,
        check=True,
        stdout=subprocess.PIPE,
    )
    return json.loads(result.stdout)


def signed(field: str, value: dict[str, Any], keys: list[dict[str, str]]) -> dict[str, Any]:
    return {field: value, "signatures": crypto(value, keys)["signatures"]}


def previous_floor(path: str | None, channel: str, build_hash: str, shell_version: str, keys: list[dict[str, str]]) -> str:
    if not path:
        return shell_version
    try:
        envelope = read_json(Path(path).resolve())
        metadata = envelope["metadata"]
        if not crypto(metadata, keys, envelope.get("signatures"))["verified"]:
            return shell_version
        if metadata.get("schemaVersion") != 3 or metadata.get("channel") != channel:
            return shell_version
        requirement = next(item for item in metadata["shellRequirements"] if item["type"] == "terminal")
        floor = requirement["minVersion"]
        if requirement["buildHash"] == build_hash and VERSION.fullmatch(floor) and tuple(map(int, floor.split("-")[0].split("."))) <= tuple(map(int, shell_version.split("-")[0].split("."))):
            return requirement["minVersion"]
    except (KeyError, StopIteration, TypeError, ValueError, OSError, subprocess.SubprocessError):
        pass
    return shell_version


def prepare(request: dict[str, Any], receipt_path: Path) -> None:
    require_release(request)
    scenes = request.get("scenes")
    if not isinstance(scenes, list) or not scenes:
        raise SystemExit("exact.prepare requires at least one Terminal scene")
    scene_records: list[dict[str, Any]] = []
    targets: set[str] = set()
    closure_scene_digest: str | None = None
    for raw in scenes:
        if not isinstance(raw, dict) or not TARGET.fullmatch(str(raw.get("target", ""))):
            raise SystemExit("invalid Terminal scene target")
        target = raw["target"]
        if target in targets:
            raise SystemExit(f"duplicate Terminal scene target: {target}")
        targets.add(target)
        directory = Path(str(raw.get("sceneDirectory", ""))).resolve()
        manifest_path = directory / "scene.json"
        binding = str(raw.get("sceneManifestSha256", ""))
        if not DIGEST.fullmatch(binding) or hashlib.sha256(manifest_path.read_bytes()).hexdigest() != binding:
            raise SystemExit(f"Terminal scene manifest binding failed: {target}")
        manifest = read_json(manifest_path)
        if manifest.get("schemaVersion") != 1 or manifest.get("target") != target or manifest.get("shellVersion") != request["shellVersion"]:
            raise SystemExit(f"Terminal scene identity mismatch: {target}")
        build_hash = str(manifest.get("shellBuildHash", ""))
        if not DIGEST.fullmatch(build_hash):
            raise SystemExit(f"Terminal scene lacks a valid build hash: {target}")
        scene_closure_digest = str(manifest.get("closure", {}).get("sha256", ""))
        if not DIGEST.fullmatch(scene_closure_digest):
            raise SystemExit(f"Terminal scene lacks a valid Closure seed binding: {target}")
        if closure_scene_digest is not None and scene_closure_digest != closure_scene_digest:
            raise SystemExit("Terminal scenes contain different Closure seeds")
        closure_scene_digest = scene_closure_digest
        scene_records.append({"target": target, "directory": str(directory), "sceneManifestSha256": binding, "shellBuildHash": build_hash})
    scene_records.sort(key=lambda item: item["target"])
    composite_hash = hashlib.sha256(canonical_bytes([{"target": item["target"], "shellBuildHash": item["shellBuildHash"]} for item in scene_records])).hexdigest()
    keys = signing_keys()
    minimum_version = previous_floor(request.get("previousContentMetadataFile"), request["channel"], composite_hash, request["shellVersion"], keys)
    output = Path(str(request.get("outputDirectory", ""))).resolve()
    artifacts = output / "artifacts"
    documents = output / "documents"
    trust = output / "trust" / "keys.json"
    artifacts.mkdir(parents=True, exist_ok=True)
    closure_source = Path(str(request.get("closureArtifactFile", ""))).resolve()
    closure_digest = hashlib.sha256(closure_source.read_bytes()).hexdigest()
    if closure_digest != closure_scene_digest:
        raise SystemExit("Closure promotion input differs from Terminal scenes")
    closure_file = artifacts / f"closure-{closure_digest}.mjs"
    shutil.copyfile(closure_source, closure_file)
    closure = described(closure_file)
    base = request["artifactBaseUrl"].rstrip("/")
    metadata = {
        "schemaVersion": 3,
        "channel": request["channel"],
        "releaseVersion": request["releaseVersion"],
        "standaloneVersion": request["standaloneVersion"],
        "sourceCommit": request["sourceCommit"],
        "publishedAt": request["publishedAt"],
        "blobs": {closure["sha256"]: {"sha256": closure["sha256"], "size": closure["size"], "mediaType": "text/javascript", "sources": [{"kind": "remote", "url": f"{base}/{closure_file.name}"}]}},
        "resources": [{"id": "closure-fixture", "blob": closure["sha256"], "sync": True, "materialization": {"type": "file", "entrypoint": "fixture.mjs"}}],
        "shellRequirements": [{"type": "terminal", "minVersion": minimum_version, "buildHash": composite_hash}],
    }
    content_file = documents / "content-metadata.json"
    write_json(content_file, signed("metadata", metadata, keys))
    write_json(trust, {"schemaVersion": 1, "keys": crypto({}, keys)["keys"]})
    write_json(receipt_path, {
        "schemaVersion": 1,
        "operation": "exact.prepare",
        "channel": request["channel"],
        "releaseVersion": request["releaseVersion"],
        "sourceCommit": request["sourceCommit"],
        "publishedAt": request["publishedAt"],
        "artifactBaseUrl": base,
        "standaloneVersion": request["standaloneVersion"],
        "shellVersion": request["shellVersion"],
        "shellBuildHash": composite_hash,
        "minimumShellVersion": minimum_version,
        "scenes": scene_records,
        "closureArtifact": closure,
        "contentMetadata": described(content_file),
        "trustFile": described(trust),
    })


def finalize(request: dict[str, Any], receipt_path: Path) -> None:
    prepare_receipt_path = Path(str(request.get("prepareReceipt", ""))).resolve()
    prepared = read_json(prepare_receipt_path)
    if prepared.get("schemaVersion") != 1 or prepared.get("operation") != "exact.prepare":
        raise SystemExit("invalid exact.prepare receipt")
    distributions = request.get("distributions")
    if not isinstance(distributions, list) or not distributions:
        raise SystemExit("exact.finalize requires native distributions")
    scene_by_target = {item["target"]: item for item in prepared["scenes"]}
    terminal_distributions: list[dict[str, Any]] = []
    closure_path = checked_description(prepared["closureArtifact"], "Closure artifact", request.get("closureArtifactFile"))
    artifacts = [{**described(closure_path), **({"mediaType": prepared["closureArtifact"]["mediaType"]} if "mediaType" in prepared["closureArtifact"] else {})}]
    seen: set[str] = set()
    for value in distributions:
        if not isinstance(value, dict):
            raise SystemExit("invalid distribution receipt descriptor")
        receipt = read_json(Path(str(value.get("receipt", ""))).resolve())
        target = receipt.get("target")
        if receipt.get("schemaVersion") != 1 or receipt.get("operation") != "terminal.distribution.build" or target not in scene_by_target or target in seen:
            raise SystemExit(f"invalid or duplicate Terminal distribution: {target}")
        seen.add(target)
        archive = dict(receipt["archive"])
        path = checked_description(archive, f"{target} Terminal distribution", value.get("archiveFile"))
        artifact = {**described(path), "mediaType": archive["mediaType"]}
        artifacts.append(artifact)
        terminal_distributions.append({
            "shell": {"type": "terminal", "version": prepared["shellVersion"], "buildHash": scene_by_target[target]["shellBuildHash"]},
            "target": target,
            "artifact": {"url": f"{prepared['artifactBaseUrl']}/{path.name}", "sha256": artifact["sha256"], "size": artifact["size"], "mediaType": artifact["mediaType"]},
            "updater": {"protocol": "standalone-shell-updater-v3", "handler": "fixture-v3", "interaction": "restart-and-install"},
        })
    if seen != set(scene_by_target):
        raise SystemExit("native distributions do not cover every prepared scene")
    terminal_distributions.sort(key=lambda item: item["target"])
    keys = signing_keys()
    output = Path(str(request.get("outputDirectory", ""))).resolve()
    documents = output / "documents"
    documents.mkdir(parents=True, exist_ok=True)
    content_source = checked_description(prepared["contentMetadata"], "content metadata", request.get("contentMetadataFile"))
    content_file = documents / "content-metadata.json"
    shutil.copyfile(content_source, content_file)
    shell_document = {
        "schemaVersion": 1,
        "channel": prepared["channel"],
        "releaseVersion": prepared["releaseVersion"],
        "sourceCommit": prepared["sourceCommit"],
        "publishedAt": prepared["publishedAt"],
        "distributions": terminal_distributions,
    }
    shell_file = documents / "terminal-metadata.json"
    write_json(shell_file, signed("document", shell_document, keys))
    content = described(content_file)
    shell = described(shell_file)
    base = prepared["artifactBaseUrl"]
    head = {
        "schemaVersion": 1,
        "channel": prepared["channel"],
        "publishedAt": prepared["publishedAt"],
        "lanes": {
            "content": {"releaseVersion": prepared["releaseVersion"], "url": f"{base}/{content_file.name}", "sha256": content["sha256"], "size": content["size"]},
            "terminal": {"releaseVersion": prepared["releaseVersion"], "url": f"{base}/{shell_file.name}", "sha256": shell["sha256"], "size": shell["size"]},
        },
    }
    head_file = documents / "channel-head.json"
    write_json(head_file, signed("head", head, keys))
    documents_described = [described(path) for path in (content_file, shell_file, head_file)]
    write_json(receipt_path, {
        "schemaVersion": 1,
        "operation": "exact.pack",
        "channel": prepared["channel"],
        "releaseVersion": prepared["releaseVersion"],
        "sourceCommit": prepared["sourceCommit"],
        "shellBuildHash": prepared["shellBuildHash"],
        "minimumShellVersion": prepared["minimumShellVersion"],
        "artifacts": artifacts,
        "documents": documents_described,
        "contentMetadataFile": str(content_file),
        "terminalMetadataFile": str(shell_file),
        "channelHeadFile": str(head_file),
    })


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", required=True, type=Path)
    parser.add_argument("--receipt", required=True, type=Path)
    args = parser.parse_args()
    request = read_json(args.request.resolve())
    if request.get("schemaVersion") != 1:
        raise SystemExit("unsupported exact pack request schema")
    operation = request.get("operation")
    if operation == "exact.prepare":
        prepare(request, args.receipt.resolve())
    elif operation == "exact.finalize":
        finalize(request, args.receipt.resolve())
    else:
        raise SystemExit("unsupported exact pack operation")


if __name__ == "__main__":
    main()
