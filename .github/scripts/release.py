#!/usr/bin/env python3
"""Publish exact receipts: immutable objects first, then a monotonic latest CAS."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import urllib.error
import urllib.request


CHANNELS = {"betahyx", "previewhyx"}


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, sort_keys=True, separators=(",", ":")) + "\n", encoding="utf-8")


def request(url: str, method: str = "GET", body: bytes | None = None, headers: dict[str, str] | None = None):
    request_headers = dict(headers or {})
    token = os.environ.get("OD_EXACT_RELEASE_TOKEN")
    if token:
        request_headers["Authorization"] = f"Bearer {token}"
    value = urllib.request.Request(url, data=body, headers=request_headers, method=method)
    try:
        return urllib.request.urlopen(value, timeout=30)
    except urllib.error.HTTPError as error:
        return error


def put_immutable(url: str, body: bytes, content_type: str) -> str:
    response = request(url, "PUT", body, {"If-None-Match": "*", "Content-Type": content_type, "Cache-Control": "public, max-age=31536000, immutable"})
    if response.status == 412:
        current = request(url)
        if current.status != 200 or current.read() != body:
            raise SystemExit(f"immutable object collision: {url}")
        return current.headers.get("ETag", "")
    if response.status not in {200, 201}:
        raise SystemExit(f"immutable upload failed ({response.status}): {url}")
    return response.headers.get("ETag", "")


def release_number(version: str, channel: str) -> tuple[int, int, int, int]:
    match = re.fullmatch(rf"(\d+)\.(\d+)\.(\d+)-{channel}\.(\d+)", version)
    if match is None:
        raise SystemExit("invalid counted release version")
    return tuple(int(match[index]) for index in range(1, 5))


def verified_file(value: dict, label: str) -> Path:
    path = Path(value["file"]).resolve()
    body = path.read_bytes()
    if hashlib.sha256(body).hexdigest() != value.get("sha256") or len(body) != value.get("size"):
        raise SystemExit(f"{label} receipt verification failed: {path}")
    return path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", required=True, type=Path)
    parser.add_argument("--receipt", required=True, type=Path)
    args = parser.parse_args()
    publish = read_json(args.request.resolve())
    if publish.get("schemaVersion") != 1 or publish.get("operation") != "exact.release":
        raise SystemExit("unsupported exact release request")
    pack = read_json(Path(publish["packReceipt"]).resolve())
    if pack.get("schemaVersion") != 1 or pack.get("operation") != "exact.pack":
        raise SystemExit("invalid exact pack receipt")
    channel = pack.get("channel")
    if channel not in CHANNELS:
        raise SystemExit("release channel must be betahyx or previewhyx")
    endpoint = str(publish["endpointUrl"]).rstrip("/")
    bucket = str(publish["bucket"]).strip("/")
    if not re.fullmatch(r"https?://[^\s]+", endpoint) or not bucket or "/" in bucket:
        raise SystemExit("invalid exact release storage endpoint or bucket")
    version = pack["releaseVersion"]
    release_number(version, channel)
    prefix = f"{endpoint}/{bucket}/{channel}"
    uploaded: list[dict] = []
    names: set[str] = set()
    for artifact in pack["artifacts"]:
        path = verified_file(artifact, "artifact")
        if path.name in names:
            raise SystemExit(f"duplicate exact object name: {path.name}")
        names.add(path.name)
        url = f"{prefix}/{version}/{path.name}"
        etag = put_immutable(url, path.read_bytes(), artifact.get("mediaType", "application/octet-stream"))
        uploaded.append({"url": url, "etag": etag, "sha256": artifact["sha256"]})
    documents: list[dict] = []
    for document in pack["documents"]:
        path = verified_file(document, "document")
        if path.name in names:
            raise SystemExit(f"duplicate exact object name: {path.name}")
        names.add(path.name)
        body = path.read_bytes()
        url = f"{prefix}/{version}/{path.name}"
        etag = put_immutable(url, body, "application/json; charset=utf-8")
        readback = request(url)
        if readback.status != 200 or readback.read() != body:
            raise SystemExit(f"exact document readback failed: {url}")
        documents.append({"url": url, "etag": etag, "sha256": document["sha256"]})
    head_path = Path(pack["channelHeadFile"]).resolve()
    head_body = head_path.read_bytes()
    latest_url = f"{prefix}/latest/channel-head.json"
    current = request(latest_url)
    headers = {"Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=60"}
    replayed = False
    if current.status == 404:
        headers["If-None-Match"] = "*"
    elif current.status == 200:
        current_body = current.read()
        if current_body == head_body:
            replayed = True
        else:
            current_head = json.loads(current_body)["head"]
            incoming_head = json.loads(head_body)["head"]
            current_lanes = current_head.get("lanes", {})
            incoming_lanes = incoming_head.get("lanes", {})
            if set(current_lanes) != set(incoming_lanes):
                raise SystemExit("channel head lane set changed during CAS")
            advanced = False
            for lane in sorted(current_lanes):
                old = current_lanes[lane]["releaseVersion"]
                new = incoming_lanes[lane]["releaseVersion"]
                if release_number(new, channel) < release_number(old, channel):
                    raise SystemExit(f"{lane} lane would move backward: {old} -> {new}")
                advanced = advanced or release_number(new, channel) > release_number(old, channel)
            if not advanced:
                raise SystemExit("channel head CAS would not advance any lane")
            etag = current.headers.get("ETag", "")
            if not etag:
                raise SystemExit("latest channel head lacks an ETag for CAS")
            headers["If-Match"] = etag
    else:
        raise SystemExit(f"latest inspection failed ({current.status})")
    if replayed:
        latest_etag = current.headers.get("ETag", "")
    else:
        promoted = request(latest_url, "PUT", head_body, headers)
        if promoted.status not in {200, 201}:
            raise SystemExit(f"latest CAS failed ({promoted.status})")
        latest_etag = promoted.headers.get("ETag", "")
    write_json(args.receipt.resolve(), {
        "schemaVersion": 1,
        "operation": "exact.release",
        "channel": channel,
        "releaseVersion": version,
        "latestChannelHeadUrl": latest_url,
        "latestChannelHeadEtag": latest_etag,
        "documents": documents,
        "artifacts": uploaded,
        "replayed": replayed,
    })


if __name__ == "__main__":
    main()
