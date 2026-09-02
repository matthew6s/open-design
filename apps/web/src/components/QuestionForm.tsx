import { Fragment,
  createContext,
  forwardRef,
  useContext,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import type {
  CSSProperties,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from 'react';
import { Button } from '@open-design/components';
import { tForLanguageTag, useT } from '../i18n';
import type { DirectionCard, FormOption, QuestionForm } from '../artifacts/question-form';
import {
  formatFormAnswers,
  formOptionValueForLabel,
  normalizeHexColor,
} from '../artifacts/question-form';
import {
  visualStyleCardsForContext,
  visualStyleFoundationDirectionId,
  type VisualStyleCard,
  type VisualStyleContext,
  type VisualStyleVariant,
} from '../runtime/visual-style-catalog';
import {
  VISUAL_STYLE_BATCH_SIZE,
  resolveVisualStyleBatch,
  rotateVisualStyleBatch,
} from '../runtime/visual-style-deck';
import { Icon } from './Icon';

export type QuestionFormInteraction =
  | {
      element: 'visual_style_card';
      questionId: string;
      styleId: string;
      styleContext: VisualStyleContext;
      /**
       * 挑中这张卡的地方。曾经还有 `'gallery'`(画廊弹窗里挑的)——
       * 那个弹窗是分页时代的溢出面,整份目录进一沓之后已整体退场(B53),
       * 于是只剩卡片自己这一条路。留着这个键是因为它描述的是**位置**,
       * 以后真要区分「一沓里挑的」和「网格里挑的」就往这里加档。
       */
      source: 'inline';
    }
  | {
      element: 'visual_style_refresh';
      questionId: string;
      styleContext: VisualStyleContext;
    }
  | {
      element: 'step_back' | 'step_next' | 'step_skip';
      questionId: string;
      stepIndex: number;
      stepCount: number;
    };

const OPTIONAL_FORM_AUTO_CONTINUE_SECONDS = 10 * 60;

interface Props {
  form: QuestionForm;
  // Whether the user can still submit answers. The owning AssistantMessage
  // disables the form when the assistant turn is no longer the most recent
  // one (i.e. the user has already moved past it).
  interactive: boolean;
  // Pre-existing answers — when we detect a follow-up user message that
  // begins with "[form answers — <id>]", we parse it back out and pass it
  // here so the rendered form reflects what was sent.
  submittedAnswers?: Record<string, string | string[]>;
  // Embedded hosts may own submission, so the form can hide its footer and
  // report draft/readiness state outward.
  hideInternalSubmit?: boolean;
  draftAnswers?: Record<string, string | string[]>;
  onReadyChange?: (ready: boolean) => void;
  onDraftChange?: (answers: Record<string, string | string[]>) => void;
  // Fires on each real user interaction with a single question (locked forms
  // never reach it), allowing the host to track finite-choice picks.
  onAnswerChange?: (questionId: string, value: string | string[]) => void;
  onInteraction?: (interaction: QuestionFormInteraction) => void;
  onSubmit?: (
    text: string,
    answers: Record<string, string | string[]>,
    source: 'submit' | 'skip' | 'auto',
    files?: QuestionFormFileSubmission[],
  ) => void;
  submitDisabled?: boolean;
  visualStyleContext?: VisualStyleContext;
  // When enabled, the form moves on after the timeout. Any unanswered field,
  // including a required one, is submitted as "(skipped)".
  autoContinueAfterTimeout?: boolean;
}

export interface QuestionFormFileSubmission {
  questionId: string;
  questionLabel: string;
  files: File[];
}

// Lets an embedding host trigger submission.
export interface QuestionFormHandle {
  submit: () => void;
  // Submit with no answers — backs the "skip all" affordance. This is an
  // explicit user decision, so it records every question as "(skipped)" and
  // moves on even when the normal form path marks a question required.
  skipAll: () => void;
}

export const QuestionFormView = forwardRef<QuestionFormHandle, Props>(function QuestionFormView(
  {
    form,
    interactive,
    submittedAnswers,
    hideInternalSubmit = false,
    draftAnswers,
    onReadyChange,
    onDraftChange,
    onAnswerChange,
    onInteraction,
    onSubmit,
    submitDisabled = false,
    visualStyleContext,
    autoContinueAfterTimeout = false,
  },
  ref,
) {
  const uiT = useT();
  // Host strings inside the card follow the form's declared content language
  // (`form.lang`, set by the model alongside the localized labels) so a
  // Chinese form in an English UI doesn't mix scripts; without a resolvable
  // tag they follow the app UI locale as before.
  const t = useMemo(() => tForLanguageTag(form.lang) ?? uiT, [form.lang, uiT]);
  const initial = useMemo(
    () => buildInitialState(form, submittedAnswers, draftAnswers, visualStyleContext),
    [form, submittedAnswers, draftAnswers, visualStyleContext],
  );
  const [answers, setAnswers] = useState<Record<string, string | string[]>>(initial);
  const [fileAnswers, setFileAnswers] = useState<Record<string, File[]>>({});
  // Question ids the user has interacted with this mount, seeded with ids
  // restored from a submitted/draft snapshot (those are prior user input).
  // "Untouched" for the streamed-default backfill below means absent here —
  // NOT "currently empty": clearing an answer is itself a touch.
  const [touched] = useState(
    () => new Set<string>(Object.keys(submittedAnswers ?? draftAnswers ?? {})),
  );
  // Finite-choice questions keep their type-in field collapsed behind a
  // host-rendered "Other" chip; this tracks which questions the user expanded
  // this mount. A question whose current answer already carries a custom
  // value (submitted history, restored draft) renders expanded without an
  // entry here — see customChoiceExpanded.
  const [otherOpen, setOtherOpen] = useState<Set<string>>(() => new Set());
  /*
   * 颜色题的 Hex 输入框、数值题的数字输入框,各自的**在编文本**。
   *
   * 它们和答案是两回事:答案任何时刻都是合法的规范值,文本则允许停在
   * 「正在敲、还不成立」的中间态。有 key 就说明用户正在这个框里打字,
   * 显示以文本为准;失焦时删掉这个 key,显示落回答案。
   *
   * 这样才做得到两件事:非法 Hex 能标错并把「下一步」按住(答案不动、
   * 不会把一个坏值提交出去),以及 1–5 的范围里想输「10」不会被第一下就吃成 1。
   */
  const [colorText, setColorText] = useState<Record<string, string>>({});
  const [rangeText, setRangeText] = useState<Record<string, string>>({});
  const [activeQuestionIndex, setActiveQuestionIndex] = useState(0);
  const [skippedQuestionIds, setSkippedQuestionIds] = useState<Set<string>>(() => new Set());
  const [autoContinueRemaining, setAutoContinueRemaining] = useState(
    OPTIONAL_FORM_AUTO_CONTINUE_SECONDS,
  );
  const autoContinuedRef = useRef(false);
  const locked = !interactive || !onSubmit || submittedAnswers !== undefined;
  // Submitted answers are held by the host in their original wire format.
  // Use the normalized snapshot for rendering so legacy tone values select
  // the same visual card that a new submission will send.
  const currentAnswers = submittedAnswers !== undefined ? initial : answers;
  const stepped = !locked && !hideInternalSubmit && form.questions.length > 1;
  const activeQuestion = form.questions[activeQuestionIndex];
  const isLastQuestion = activeQuestionIndex === form.questions.length - 1;
  const questionsToRender = stepped && activeQuestion ? [activeQuestion] : form.questions;
  /*
   * 交付稿第 21 / 22 格的底栏**只有一行**,逐颗核对过是 `换一批 | 随机 | 下一步` 三颗
   * (曾经记成还有一颗「撑开」——**没有**;「铺开成网格」是选项区右上角那枚开关,不在底栏)。
   * 我们原来是两行 —— 选择器自带一行(换一批 / 随机),卡片底栏又是一行(跳过 / 下一步)。
   *
   * 合并的方向是**把「下一步」交给选择器那一行**,不是反过来把两颗动作提上来:
   * 「换一批 / 随机」的闭包(翻牌、重置这一沓、还剩几张)长在选择器里,提上来要搬一整套状态;
   * 而「下一步」只依赖这里已有的 `handleSubmit` / `ready`,顺着 props 往下传就行。
   * (试过 portal:`renderToStaticMarkup` 不渲染 portal,验收陈列页会照出一行空插槽。)
   *
   * 只在「这张卡上就这一道视觉方向题」时合并 —— 多道题时每道都有自己的选择器,
   * 「下一步」只有一颗,往哪一行放都是错的,那时保持两行。
   */
  const soleQuestion = questionsToRender.length === 1 ? questionsToRender[0] : undefined;
  const visualFootDelegated =
    !locked
    && !stepped
    && !hideInternalSubmit
    && Boolean(
      visualStyleContext
      && soleQuestion
      && soleQuestion.id === 'tone'
      && (soleQuestion.type === 'checkbox' || soleQuestion.type === 'radio')
      && soleQuestion.options,
    );
  /** 多选题勾了几行 —— 稿子把它摆在卡头右侧(`.h .n`) */
  const pickedCount = questionsToRender.reduce((sum, q) => {
    return sum + pickedCheckboxChoiceCount(
      q,
      currentAnswers[q.id],
      visualStyleContext,
      otherOpen.has(q.id),
    );
  }, 0);

  useEffect(() => {
    setActiveQuestionIndex(0);
    setSkippedQuestionIds(new Set());
  }, [form.id]);

  useEffect(() => {
    setActiveQuestionIndex((current) =>
      Math.min(current, Math.max(0, form.questions.length - 1)),
    );
  }, [form.questions.length]);

  function hasCustomAnswer(q: QuestionForm['questions'][number]): boolean {
    const value = currentAnswers[q.id];
    return q.type === 'checkbox'
      ? customCheckboxValue(q, value).length > 0
      : customSingleValue(q, value).length > 0;
  }

  // Whether a finite-choice question shows its custom type-in field. Locked
  // forms only ever show it when the recorded answer is a custom value.
  function customChoiceExpanded(q: QuestionForm['questions'][number]): boolean {
    if (locked) return hasCustomAnswer(q);
    return otherOpen.has(q.id) || hasCustomAnswer(q);
  }

  // Toggle the "Other" chip. Opening a single-choice question's field
  // deselects the fixed options (the user is saying "none of these");
  // collapsing discards any custom text and keeps only known option values.
  function toggleOther(q: QuestionForm['questions'][number]) {
    if (locked) return;
    const expanded = customChoiceExpanded(q);
    setOtherOpen((prev) => {
      const next = new Set(prev);
      if (expanded) next.delete(q.id);
      else next.add(q.id);
      return next;
    });
    if (expanded) {
      if (q.type === 'checkbox') {
        const current = Array.isArray(answers[q.id]) ? (answers[q.id] as string[]) : [];
        update(q.id, current.filter((entry) => questionValueIsKnown(q, entry)));
      } else {
        const current = typeof answers[q.id] === 'string' ? (answers[q.id] as string) : '';
        if (!questionValueIsKnown(q, current)) update(q.id, '');
      }
    } else if (q.type !== 'checkbox') {
      update(q.id, '');
    }
  }

  /* ── 颜色:预设色块 / 系统取色器 / Hex 输入,三条路一个落点 ───────── */

  /** 预设色块和系统取色器走这条 —— 它们只可能给出合法值,直接落地并收掉在编文本。 */
  function pickColor(q: QuestionForm['questions'][number], raw: string) {
    const canonical = normalizeHexColor(raw);
    if (!canonical) return;
    clearDraftText(setColorText, q.id);
    update(q.id, canonical);
  }

  /**
   * Hex 框在敲字。合法就同步落到答案(取色器和色块立刻跟上),
   * 不合法只留着文本 —— 答案保持上一个合法值,由 `ready` 把「下一步」按住。
   */
  function typeColor(q: QuestionForm['questions'][number], raw: string) {
    setColorText((prev) => ({ ...prev, [q.id]: raw }));
    const canonical = normalizeHexColor(raw);
    if (canonical) update(q.id, canonical);
  }

  /** 失焦:文本让位给答案。合法值收成规范形,非法值直接回滚(稿子 `hex.blur` 的行为)。 */
  function settleColor(q: QuestionForm['questions'][number]) {
    clearDraftText(setColorText, q.id);
  }

  /* ── 数值滑块:滑杆与数字输入共用一个值 ─────────────────────────── */

  function dragRange(q: QuestionForm['questions'][number], raw: string) {
    clearDraftText(setRangeText, q.id);
    update(q.id, String(clampRangeValue(Number(raw), q)));
  }

  function typeRange(q: QuestionForm['questions'][number], raw: string) {
    setRangeText((prev) => ({ ...prev, [q.id]: raw }));
    const parsed = Number(raw);
    if (raw.trim().length === 0 || !Number.isFinite(parsed)) return;
    update(q.id, String(clampRangeValue(parsed, q)));
  }

  /**
   * 失焦:只把在编文本让位给答案,显示于是从「99」跳回收好的「5」。
   *
   * 这里**不需要**再算一次 clamp —— `typeRange` 每一次可解析的输入都已经把
   * 收好的值落到答案上了,答案任何时刻都是合法的。曾经在这儿又写了一遍同样的
   * 计算:撤掉它测试全绿(说明它一次也没起过作用),留着只是给同一条规则
   * 攒第二个会漂的实现。
   */
  function settleRange(q: QuestionForm['questions'][number]) {
    clearDraftText(setRangeText, q.id);
  }

  // Picking a fixed option collapses an open (and still empty) "Other" field
  // on single-choice questions; checkbox questions keep it open since fixed
  // and custom entries coexist.
  function pickFixed(q: QuestionForm['questions'][number], value: string) {
    setOtherOpen((prev) => {
      if (!prev.has(q.id)) return prev;
      const next = new Set(prev);
      next.delete(q.id);
      return next;
    });
    update(q.id, value);
  }

  /**
   * 「自己填」—— 交付稿 `.opt.mod-own`,是选项列表里的**最后一项**,输入框**内嵌在这一项里**。
   *
   *   <div class="opt mod-own is-on is-open">
   *     <span class="box">✓</span>
   *     <span class="own">
   *       <span class="own-l">自己填</span>
   *       <textarea class="own-ta" rows="1" placeholder="用你自己的说法写 —— …"></textarea>
   *     </span>
   *   </div>
   *
   * 原来这里是「其他」两个字 + 列表**之后**另起的一块折叠输入框。三处都不对:
   * 文案(稿子全文没有「其他」)、位置(输入框不在这一项里)、以及那块折叠动画(稿子没有)。
   *
   * 与稿子唯一的形状差别:那枚勾选框用真 `<button>`(稿子是静态 `<span>`)——
   * 稿子是张不能点的图,产品里这枚必须能用键盘操作。视觉一致,可达性更好。
   */
  function renderOwnChoice(
    q: QuestionForm['questions'][number],
    value: string,
    onChangeOwn: (next: string) => void,
  ) {
    const on = customChoiceExpanded(q);
    const label = q.customLabel ?? t('qf.ownAnswer');
    // 收起态:稿子和别的选项一模一样,是 `<button class="opt mod-own">`
    if (!on) {
      return (
        <button
          type="button"
          className="qf-chip qf-chip-other"
          data-chat-scroll-anchor={`question-own:${q.id}`}
          data-chat-preserve-scroll-anchor={`question-own:${q.id}`}
          aria-pressed={false}
          disabled={locked}
          onClick={() => toggleOther(q)}
        >
          <span className="qf-chip-box"><ChipCheck /></span>
          <span className="qf-own-label">{label}</span>
        </button>
      );
    }
    // 展开态:稿子换成 `<div class="opt mod-own is-on is-open">`,输入框内嵌在这一项里
    return (
      <div
        className="qf-chip qf-chip-other qf-chip-on qf-chip-open"
        data-chat-scroll-anchor={`question-own:${q.id}`}
      >
        <button
          type="button"
          className="qf-chip-own-box"
          data-chat-preserve-scroll-anchor={`question-own:${q.id}`}
          aria-pressed
          aria-label={label}
          disabled={locked}
          onClick={() => toggleOther(q)}
        >
          <ChipCheck />
        </button>
        <span className="qf-own">
          <span className="qf-own-label">{label}</span>
          <textarea
            rows={1}
            className="qf-own-input qf-input"
            data-testid="qf-input"
            value={value}
            placeholder={q.customPlaceholder ?? t('qf.customPlaceholder')}
            disabled={locked}
            onChange={(e) => onChangeOwn(e.target.value)}
          />
        </span>
      </div>
    );
  }

  useEffect(() => {
    setFileAnswers({});
  }, [form.id]);

  // When the form streams in question-by-question, backfill state for newly
  // revealed questions without disturbing answers the user already touched.
  useEffect(() => {
    setAnswers((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const q of form.questions) {
        if (next[q.id] !== undefined) {
          if (shouldAdoptStreamedDefault(q, next[q.id]!, touched)) {
            next[q.id] = canonicalizeQuestionValue(
              q,
              q.defaultValue!,
              visualStyleContext,
            );
            changed = true;
          }
          continue;
        }
        changed = true;
        if (submittedAnswers && submittedAnswers[q.id] !== undefined) {
          next[q.id] = canonicalizeQuestionValue(
            q,
            submittedAnswers[q.id]!,
            visualStyleContext,
          );
        } else if (q.defaultValue !== undefined) {
          next[q.id] = canonicalizeQuestionValue(q, q.defaultValue, visualStyleContext);
        } else {
          next[q.id] = emptyQuestionValue(q);
        }
      }
      return changed ? next : prev;
    });
  }, [form, submittedAnswers, touched, visualStyleContext]);

  function update(id: string, value: string | string[]) {
    if (locked) return;
    touched.add(id);
    const next = { ...answers, [id]: value };
    setAnswers(next);
    setSkippedQuestionIds((current) => {
      if (!current.has(id)) return current;
      const nextSkipped = new Set(current);
      nextSkipped.delete(id);
      return nextSkipped;
    });
    onDraftChange?.(draftSafeAnswers(form, next));
    onAnswerChange?.(id, value);
  }

  function toggleCheckbox(id: string, option: string, maxSelections?: number) {
    if (locked) return;
    const current = Array.isArray(answers[id]) ? (answers[id] as string[]) : [];
    const has = current.includes(option);
    if (!has && maxSelections !== undefined && current.length >= maxSelections) return;
    touched.add(id);
    const next = has ? current.filter((v) => v !== option) : [...current, option];
    const nextAnswers = { ...answers, [id]: next };
    setAnswers(nextAnswers);
    setSkippedQuestionIds((currentSkipped) => {
      if (!currentSkipped.has(id)) return currentSkipped;
      const nextSkipped = new Set(currentSkipped);
      nextSkipped.delete(id);
      return nextSkipped;
    });
    onDraftChange?.(draftSafeAnswers(form, nextAnswers));
    onAnswerChange?.(id, next);
  }

  function updateCheckboxCustom(q: QuestionForm['questions'][number], raw: string) {
    if (locked) return;
    const current = Array.isArray(answers[q.id]) ? (answers[q.id] as string[]) : [];
    const fixed = current.filter((entry) => questionValueIsKnown(q, entry));
    update(q.id, [...fixed, ...splitCustomEntries(raw)]);
  }

  function finalizeSubmission(
    source: 'submit' | 'skip' | 'auto',
    skippedIds: ReadonlySet<string> = skippedQuestionIds,
  ) {
    if (!onSubmit) return;
    const submittedAnswers = answersWithSkippedQuestions(form, answers, skippedIds);
    const submissionForm = formWithVisualStyleOptions(form, visualStyleContext);
    const files = collectFileSubmissions(form, fileAnswers, skippedIds);
    if (files.length > 0) {
      onSubmit(formatFormAnswers(submissionForm, submittedAnswers), submittedAnswers, source, files);
    } else {
      onSubmit(formatFormAnswers(submissionForm, submittedAnswers), submittedAnswers, source);
    }
  }

  function handleSubmit() {
    if (locked || !onSubmit) return;
    // Block submit until required fields are answered and selection caps hold.
    if (!ready) return;
    finalizeSubmission('submit');
  }

  function handleSkipAll() {
    if (locked || !onSubmit) return;
    const empty: Record<string, string | string[]> = {};
    onSubmit(formatFormAnswers(formWithVisualStyleOptions(form, visualStyleContext), empty), empty, 'skip');
  }

  function handleSkipCurrent() {
    if (locked || !onSubmit || !activeQuestion) return;
    onInteraction?.({
      element: 'step_skip',
      questionId: activeQuestion.id,
      stepIndex: activeQuestionIndex + 1,
      stepCount: form.questions.length,
    });
    const nextSkipped = new Set(skippedQuestionIds);
    nextSkipped.add(activeQuestion.id);
    setSkippedQuestionIds(nextSkipped);
    if (!isLastQuestion) {
      setActiveQuestionIndex((current) => current + 1);
      return;
    }
    finalizeSubmission('skip', nextSkipped);
  }

  function handlePreviousQuestion() {
    if (!activeQuestion || activeQuestionIndex === 0) return;
    onInteraction?.({
      element: 'step_back',
      questionId: activeQuestion.id,
      stepIndex: activeQuestionIndex + 1,
      stepCount: form.questions.length,
    });
    setActiveQuestionIndex((current) => Math.max(0, current - 1));
  }

  function handleNextQuestion() {
    if (!activeQuestion || isLastQuestion || !currentQuestionReady) return;
    onInteraction?.({
      element: 'step_next',
      questionId: activeQuestion.id,
      stepIndex: activeQuestionIndex + 1,
      stepCount: form.questions.length,
    });
    setActiveQuestionIndex((current) => current + 1);
  }

  // Per-question checkbox selection caps must hold.
  const withinSelectionLimits = form.questions.every((q) => {
    if (q.type !== 'checkbox' || q.maxSelections === undefined) return true;
    const v = currentAnswers[q.id];
    return !Array.isArray(v) || v.length <= q.maxSelections;
  });
  // 有选项的问题必须先有答案,不想答走旁边的「跳过」——「跳过」会把值序列化成
  // "(skipped)",让 agent 拿默认值往下走。判据来自交付稿意图澄清那五格的状态标签
  // (5-1「一个都没选 ——『下一步』置灰」/ 5-4「没写字前『下一步』仍置灰」)。
  const requiredAnswered = form.questions.every((q) => {
    if (!questionNeedsAnswer(q)) return true;
    if (skippedQuestionIds.has(q.id)) return true;
    const v = currentAnswers[q.id];
    return questionAnswerIsPresent(v);
  });
  /*
   * 稿子:「Hex 非法时『下一步』置灰」。这一条和 `required` 无关 —— 用户已经
   * 在框里写了东西,只是写得不成立;这时放行会把上一个颜色当成他的选择提交出去。
   * 判据只看**在编文本**:没在编(或编的是合法值)就不拦。
   */
  const colorTextIsInvalid = (id: string): boolean => {
    const raw = colorText[id];
    return raw !== undefined && normalizeHexColor(raw) === null;
  };
  const noColorTextPending = form.questions.every(
    (q) => q.type !== 'color' || !colorTextIsInvalid(q.id),
  );
  const ready = withinSelectionLimits && requiredAnswered && noColorTextPending;
  /* 底栏和视觉方向那一行**共用同一颗**「下一步」—— 各造一份迟早会漂 */
  const submitButton = (
    <Button
      type="button"
      size="sm"
      variant="primary"
      className="qf-primary-action"
      onClick={handleSubmit}
      disabled={submitDisabled || !ready}
      title={!submitDisabled && ready ? t('qf.submitTitle') : t('qf.submitDisabledTitle')}
    >
      {form.submitLabel ?? t('qf.submitDefault')}
    </Button>
  );
  // A manual Skip all is always available, including for required questions.
  const canSkipAll = true;
  const hasRequiredQuestions = form.questions.some((q) => q.required === true);
  // Timeout continuation shares the explicit Skip semantics: unanswered
  // questions, including required ones, are serialized as "(skipped)".
  const autoContinueEnabled =
    autoContinueAfterTimeout &&
    !locked &&
    !submitDisabled;
  const currentQuestionReady = ((): boolean => {
    if (!activeQuestion) return true;
    // 分步态下「下一步」也不许在半截的 Hex 上放行
    if (colorTextIsInvalid(activeQuestion.id)) return false;
    if (!questionNeedsAnswer(activeQuestion)) return true;
    if (skippedQuestionIds.has(activeQuestion.id)) return true;
    return questionAnswerIsPresent(currentAnswers[activeQuestion.id]);
  })();
  const autoContinueCountdown = `${Math.floor(autoContinueRemaining / 60)}:${String(
    autoContinueRemaining % 60,
  ).padStart(2, '0')}`;

  useImperativeHandle(ref, () => ({ submit: handleSubmit, skipAll: handleSkipAll }));
  useEffect(() => {
    onReadyChange?.(!locked && ready);
  }, [onReadyChange, locked, ready]);
  useEffect(() => {
    if (!autoContinueEnabled) {
      setAutoContinueRemaining(OPTIONAL_FORM_AUTO_CONTINUE_SECONDS);
      autoContinuedRef.current = false;
      return;
    }
    setAutoContinueRemaining(OPTIONAL_FORM_AUTO_CONTINUE_SECONDS);
    autoContinuedRef.current = false;
    const timer = window.setInterval(() => {
      setAutoContinueRemaining((current) => Math.max(0, current - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [autoContinueEnabled, form.id]);
  useEffect(() => {
    if (
      !autoContinueEnabled ||
      autoContinueRemaining > 0 ||
      autoContinuedRef.current ||
      !onSubmit
    ) {
      return;
    }
    autoContinuedRef.current = true;
    finalizeSubmission('auto');
  }, [answers, autoContinueEnabled, autoContinueRemaining, fileAnswers, form, onSubmit]);

  /*
   * 回答完就**收成一条陈述**(交付稿 #23 / #24 / #25),不再把整张表单锁住置灰。
   *
   * 我原来把这条挂成 T11「待产品拍板:收成陈述 vs 锁住表单」—— 稿子画得清清楚楚就是收成陈述,
   * 是把一个稿子已经回答的问题当成了「产品没定」。
   *
   * 判据是 **`submittedAnswers` 给了 + 不可交互**,两个条件缺一不可:
   * `submittedAnswers` 自己不够 —— 它也用来把历史答案**回填进可编辑的表单**
   * (`interactive` 为真的那条路径)。只看它就会把「回填后还能改」收成静态陈述,
   * 等于弄丢编辑能力。这是老用例
   * 「renders restored legacy visual tone answers on their matching cards」拦下来的。
   */
  if (submittedAnswers !== undefined && !interactive) {
    return (
      <AnsweredSummary
        form={form}
        answers={submittedAnswers}
        visualStyleContext={visualStyleContext}
        t={t}
      />
    );
  }

  return (
    <div className={`question-form${locked ? ' question-form-locked' : ''}`} data-form-id={form.id}>
      <div className="question-form-head">
        {/*
          稿子的卡头是 `.hd > svg + b` —— 图标**直接**放在头里,标题也不套包裹层。
          原来这里多包了 `span.question-form-icon` 和 `div.question-form-titles` 两层,
          逐元素比样式时两边序列从第 1 个就错开,后面全部串位。
          (图标路径逐字取自交付稿 `.hd-ic`)
        */}
        <svg className="question-form-icon" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
            <path d="M18.3644 1.80762C18.6295 1.80769 18.8839 1.91312 19.0714 2.10059L21.8995 4.92871C22.29 5.31919 22.2899 5.95224 21.8995 6.34277L18.2276 10.0146C19.2826 11.3871 20.0766 12.7665 20.5108 14.0059C20.7653 14.7323 20.9135 15.4571 20.8878 16.1279C20.8618 16.8063 20.6529 17.4897 20.1319 18.0107C19.3188 18.8238 18.1404 18.8753 17.0909 18.6602C16.0059 18.4376 14.789 17.885 13.5646 17.1104L14.6339 15.4199C15.7393 16.1193 16.7271 16.5441 17.4933 16.7012C18.2945 16.8654 18.6149 16.6996 18.7179 16.5967C18.7857 16.5288 18.877 16.3822 18.8897 16.0518C18.9027 15.7134 18.8269 15.2486 18.6231 14.667C18.2955 13.732 17.6762 12.6159 16.7999 11.4424L14.8282 13.4141C14.6407 13.6016 14.3864 13.707 14.1212 13.707H11.2931C10.7408 13.707 10.2931 13.2593 10.2931 12.707V9.87891C10.2931 9.61372 10.3985 9.3594 10.586 9.17188L12.4435 7.31348C11.2356 6.6015 10.012 6.19175 8.91026 6.08594C7.51104 5.95164 6.38043 6.30526 5.63584 7.0498C4.77429 7.91135 4.43188 9.30214 4.77354 11.0107C5.11363 12.7112 6.12068 14.605 7.75791 16.2422C9.51568 18 11.5651 19.0286 13.3526 19.29L13.0636 21.2686C10.7846 20.9353 8.35467 19.669 6.34287 17.6572C4.46542 15.7798 3.24029 13.5416 2.8126 11.4033C2.38658 9.2732 2.74022 7.1173 4.22178 5.63574C5.49617 4.3614 7.27806 3.91963 9.10166 4.09473C10.6796 4.24628 12.3422 4.86047 13.8966 5.86035L17.6573 2.10059L17.7306 2.03418C17.9085 1.88844 18.1323 1.80762 18.3644 1.80762ZM12.2931 10.293V11.707H13.7071L19.7784 5.63574L18.3644 4.22168L12.2931 10.293Z" />
        </svg>
        {/* 稿子的卡头标题是 `<b>`(`.card > .h b { font-weight: inherit }`),不是 div ——
            标签不一样,逐元素比样式时从这里开始整段串位 */}
        <b className="question-form-title">{form.title}</b>
        {stepped ? (
          <span
            className="qf-step-progress"
            aria-label={`${activeQuestionIndex + 1} / ${form.questions.length}`}
          >
            {activeQuestionIndex + 1}/{form.questions.length}
          </span>
        ) : null}
        {pickedCount > 0 ? <PickedCount t={t} count={pickedCount} /> : null}
        {locked ? <span className="question-form-pill">{t('qf.answered')}</span> : null}
      </div>
      <div className="question-form-body">
        {questionsToRender.map((q) => {
          const value = currentAnswers[q.id];
          /*
           * 内置风格目录接管哪几道题(2026-08-26 用户裁决:「为什么不把 tone 的内容
           * 换到 direction-cards 里?」)。
           *
           * 目录是**产品自己的功能**:每个 context 一沓真预览图,共 96 张,住在 R2
           * (`repo-assets.open-design.ai/style-catalog/v1/`)。而模型**现开**的
           * `direction-cards` 没有素材 —— 预览面只能画占位块,用户看到的就是几张
           * 「纯色卡」。同一件事(选视觉方向)不该有真图和占位块两副样子。
           *
           * 所以判据从「id 恰好叫 tone」放宽到「**这道题在问视觉方向**」:
           *  · discovery 简报里的 `tone`(模型按提示词发的纯文字选项);
           *  · 模型自己开的 `direction-cards`。
           * 两者都由目录接管,前提是这个项目**有视觉风格上下文**(deck / prototype /
           * document / image / video)—— 没有上下文就没有对应的那一沓,只能原样渲染。
           *
           * 为什么换掉模型的选项不会「说两件事」:答案是按 `formatFormAnswers` 拼成
           * **文本行**回给模型的(`- 视觉方向: Content-led product`),不是机器 id 契约。
           * `tone` 那条路今天就是这么替换的,已经在线上跑着。
           */
          const asksVisualDirection =
            (q.id === 'tone' && (q.type === 'checkbox' || q.type === 'radio') && !!q.options) ||
            q.type === 'direction-cards';
          const visualStyleCards =
            visualStyleContext && asksVisualDirection
              ? visualStyleCardsForContext(visualStyleContext)
              : null;
          return (
            /*
              稿子的 `.cbody` 直接放 `.q` + `.opts`,中间没有「一个问题一个字段容器」这层。
              内距挂在子元素上(`.q` 是 10/11/8,`.opts.mod-stack` 是 0 6px 8px),不是挂在容器上。
              留着这层会让两边的元素序列从第一个问题就错位,后面全部对不上。
            */
            <Fragment key={q.id}>
              {/*
                稿子里问题就是一个 `.cbody > .q` 的普通块,不是 `<label><span>…</span></label>`。
                多包的这两层让逐元素比样式时两边从这里开始串位;而且这个 label 没有关联控件
                (每个选项自己带 label),挂着也不起作用。
              */}
              <div className="qf-label">
                {q.label}
                {q.required ? <span className="qf-required">{t('qf.required')}</span> : null}
              </div>
              {q.help ? <div className="qf-help">{q.help}</div> : null}
              {(q.type === 'radio' || q.type === 'select') && q.options && !visualStyleCards ? (
                <div className="qf-options" role="radiogroup" aria-label={q.label}>
                  {q.options.map((opt) => (
                    <OptionButton
                      key={opt.value}
                      option={opt}
                      role="radio"
                      on={value === opt.value}
                      disabled={locked}
                      onPick={() => pickFixed(q, opt.value)}
                    />
                  ))}
                  {shouldRenderCustomChoice(q)
                    ? renderOwnChoice(q, customSingleValue(q, value), (next) => update(q.id, next))
                    : null}
                </div>
              ) : null}
              {q.type === 'checkbox' && q.options && !visualStyleCards ? (
                <div className="qf-options" role="group" aria-label={q.label}>
                  {q.options.map((opt) => {
                    const arr = Array.isArray(value) ? value : [];
                    const on = arr.includes(opt.value);
                    const maxed =
                      q.maxSelections !== undefined && !on && arr.length >= q.maxSelections;
                    return (
                      <OptionButton
                        key={opt.value}
                        option={opt}
                        role="checkbox"
                        on={on}
                        maxed={maxed}
                        disabled={locked || maxed}
                        onPick={() => toggleCheckbox(q.id, opt.value, q.maxSelections)}
                      />
                    );
                  })}
                  {shouldRenderCustomChoice(q)
                    ? renderOwnChoice(q, customCheckboxValue(q, value), (next) => updateCheckboxCustom(q, next))
                    : null}
                </div>
              ) : null}
              {visualStyleCards && visualStyleContext ? (
                <VisualStylePicker
                  cards={visualStyleCards}
                  context={visualStyleContext}
                  formId={form.id}
                  questionId={q.id}
                  value={
                    Array.isArray(value)
                      ? value
                      : typeof value === 'string' && value
                        ? [value]
                        : []
                  }
                  disabled={locked}
                  selectionMode={q.type === 'checkbox' ? 'multiple' : 'single'}
                  maxSelections={q.type === 'checkbox' ? q.maxSelections : 1}
                  onChange={(next) =>
                    update(q.id, q.type === 'radio' ? (next[0] ?? '') : next)
                  }
                  onInteraction={onInteraction}
                  submitSlot={visualFootDelegated ? submitButton : undefined}
                />
              ) : null}

              {q.type === 'text' ? (
                <input
                  type="text"
                  className="qf-input"
                  data-testid="qf-input"
                  value={typeof value === 'string' ? value : ''}
                  placeholder={q.placeholder}
                  disabled={locked}
                  onChange={(e) => update(q.id, e.target.value)}
                />
              ) : null}
              {q.type === 'number' ? (
                <input
                  type="number"
                  className="qf-input"
                  data-testid="qf-input"
                  value={typeof value === 'string' ? value : ''}
                  placeholder={q.placeholder}
                  min={q.min}
                  max={q.max}
                  step={q.step}
                  disabled={locked}
                  onChange={(e) => update(q.id, e.target.value)}
                />
              ) : null}
              {q.type === 'range' ? (
                <AmountChoice
                  question={q}
                  answer={typeof value === 'string' ? value : ''}
                  text={rangeText[q.id]}
                  disabled={locked}
                  onDrag={(raw) => dragRange(q, raw)}
                  onType={(raw) => typeRange(q, raw)}
                  onSettle={() => settleRange(q)}
                />
              ) : null}
              {q.type === 'date' || q.type === 'time' || q.type === 'datetime-local' ? (
                <input
                  type={q.type}
                  className="qf-input"
                  data-testid="qf-input"
                  value={typeof value === 'string' ? value : ''}
                  placeholder={q.placeholder}
                  disabled={locked}
                  onChange={(e) => update(q.id, e.target.value)}
                />
              ) : null}
              {q.type === 'color' ? (
                <ColorChoice
                  question={q}
                  color={normalizeColorInputValue(value)}
                  text={colorText[q.id]}
                  invalid={colorTextIsInvalid(q.id)}
                  disabled={locked}
                  t={t}
                  onPick={(raw) => pickColor(q, raw)}
                  onType={(raw) => typeColor(q, raw)}
                  onSettle={() => settleColor(q)}
                />
              ) : null}
              {q.type === 'url' || q.type === 'email' || q.type === 'tel' ? (
                <input
                  type={q.type}
                  className="qf-input"
                  data-testid="qf-input"
                  value={typeof value === 'string' ? value : ''}
                  placeholder={q.placeholder}
                  disabled={locked}
                  onChange={(e) => update(q.id, e.target.value)}
                />
              ) : null}
              {q.type === 'file' ? (
                <div className="qf-file-wrap">
                  <input
                    type="file"
                    className="qf-file"
                    multiple={q.multiple}
                    accept={q.accept}
                    disabled={locked}
                    onChange={(e) => {
                      const files = Array.from(e.target.files ?? []);
                      const names = files.map((file) => file.name);
                      setFileAnswers((current) => ({ ...current, [q.id]: files }));
                      update(q.id, q.multiple ? names : names[0] ?? '');
                    }}
                  />
                  {fileValueLabel(value) ? (
                    <div className="qf-file-summary">{fileValueLabel(value)}</div>
                  ) : null}
                </div>
              ) : null}
              {q.type === 'switch' ? (
                <label className="qf-switch">
                  <input
                    type="checkbox"
                    role="switch"
                    checked={value === 'true'}
                    disabled={locked}
                    onChange={(e) => update(q.id, e.target.checked ? 'true' : 'false')}
                  />
                  <span aria-hidden />
                </label>
              ) : null}
              {q.type === 'textarea' ? (
                <textarea
                  className="qf-textarea"
                  value={typeof value === 'string' ? value : ''}
                  placeholder={q.placeholder}
                  disabled={locked}
                  rows={3}
                  onChange={(e) => update(q.id, e.target.value)}
                />
              ) : null}
              {q.type === 'direction-cards' && !visualStyleCards && q.cards && q.cards.length > 0 ? (
                <DirectionCardsPicker
                  cards={q.cards}
                  formId={form.id}
                  questionId={q.id}
                  value={typeof value === 'string' ? value : ''}
                  disabled={locked}
                  onSelect={(cardId) => pickFixed(q, cardId)}
                />
              ) : null}
              {q.type === 'direction-cards' && !visualStyleCards && q.cards && q.cards.length > 0 && shouldRenderCustomChoice(q) ? (
                <div className="qf-options">
                  {renderOwnChoice(q, customSingleValue(q, value), (next) => update(q.id, next))}
                </div>
              ) : null}
            </Fragment>
          );
        })}
        {/* 稿子里底栏在 `.cbody` 里面(白底那一块):`.cbody > .foot`。
            挪到 body 外面,底栏就落在卡的面板底色上,和稿子差一层底色。 */}
        {/* 「下一步」已经交给视觉方向那一行时,这里整段不出 ——
            稿子第 21 / 22 格的底栏就那一行,再留一条空的底栏会多撑出 8px + 一行高。 */}
        {hideInternalSubmit || visualFootDelegated ? null : (
          <div className="question-form-foot" data-chat-scroll-anchor="question-footer">
            {locked ? (
              <span className="qf-locked-note">
                {submittedAnswers ? t('qf.lockedSubmitted') : t('qf.lockedPrev')}
              </span>
            ) : stepped ? (
              <>
                {autoContinueEnabled ? (
                  <span
                    className="qf-auto-continue"
                    title={t('questions.autoSkipHint')}
                    aria-label={`${t('questions.autoSkipHint')} ${autoContinueCountdown}`}
                  >
                    {autoContinueCountdown}
                  </span>
                ) : null}
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  data-chat-preserve-scroll-anchor={
                    !isLastQuestion ? 'question-footer' : undefined
                  }
                  onClick={handleSkipCurrent}
                  disabled={submitDisabled}
                >
                  {t('questionForm.skip')}
                </Button>
                <span className="qf-submit-actions">
                  {activeQuestionIndex > 0 ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      data-chat-preserve-scroll-anchor="question-footer"
                      onClick={handlePreviousQuestion}
                      disabled={submitDisabled}
                    >
                      {t('settings.onboardingBack')}
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    size="sm"
                    variant="primary"
                    className="qf-primary-action"
                    data-chat-preserve-scroll-anchor={
                      !isLastQuestion ? 'question-footer' : undefined
                    }
                    onClick={
                      isLastQuestion
                        ? handleSubmit
                        : handleNextQuestion
                    }
                    disabled={
                      submitDisabled || (isLastQuestion ? !ready : !currentQuestionReady)
                    }
                    title={
                      !submitDisabled && activeQuestion?.required === true && !currentQuestionReady
                        ? t('qf.submitDisabledTitle')
                        : isLastQuestion && !submitDisabled && ready
                          ? t('qf.submitTitle')
                          : undefined
                    }
                  >
                    {isLastQuestion
                      ? form.submitLabel ?? t('qf.submitDefault')
                      : t('nextStep.title')}
                  </Button>
                </span>
              </>
            ) : autoContinueEnabled ? (
              <span
                className="qf-auto-continue"
                title={t('questions.autoSkipHint')}
                aria-label={`${t('questions.autoSkipHint')} ${autoContinueCountdown}`}
              >
                {autoContinueCountdown}
              </span>
            ) : null}
            {!locked && !stepped ? (
              <>
                {canSkipAll ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={handleSkipAll}
                    disabled={submitDisabled}
                  >
                    {t('questions.skipAll')}
                  </Button>
                ) : null}
                {/* 撑开:稿子里跳过靠左、下一步靠右,中间是空的 */}
                <span className="qf-foot-gap" />
                {submitButton}
              </>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
});

/**
 * 勾选框里的那枚对勾 —— 稿子 `.opt .box > svg.ck`。
 *
 * 稿子里它**从来不显示**(单选 `display:none`、多选选中态也 `display:none`,
 * 其余时候 `opacity:0`):选中与否画在方框自己身上(`--tick-img` 铺底)。
 * 照抄是为了两边元素序列一一对上 —— 少一个节点,后面每一项都要串位。
 */
function ChipCheck() {
  return (
    <svg className="qf-chip-check" viewBox="0 0 24 24" aria-hidden>
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}

/**
 * 一个固定选项 —— 交付稿 `.opt`:
 *
 *   <button class="opt" type="button">
 *     <span class="box"><svg class="ck">…</svg></span><span>文案</span>
 *   </button>
 *
 * 原来是 `<label>` 套一枚真 `<input type=radio|checkbox>`。视觉能凑近,但**标签就不一样**,
 * 逐元素比样式时从这里开始整段串位,后面每一项都被报成差异,真差异全淹了。
 *
 * 可达性不靠原生控件靠 ARIA 补齐:外面那层 `.qf-options` 是 `radiogroup` / `group`,
 * 每一项自己声明 `role` 和 `aria-checked`,而且每一项都能 Tab 到、能用空格/回车选。
 */
function OptionButton({
  option,
  role,
  on,
  maxed,
  disabled,
  onPick,
}: {
  option: FormOption;
  role: 'radio' | 'checkbox';
  on: boolean;
  maxed?: boolean;
  disabled?: boolean;
  onPick: () => void;
}) {
  return (
    <button
      type="button"
      role={role}
      aria-checked={on}
      title={option.description}
      disabled={disabled === true}
      className={`qf-chip${on ? ' qf-chip-on' : ''}${maxed === true ? ' qf-chip-disabled' : ''}`}
      onClick={onPick}
    >
      <span className="qf-chip-box"><ChipCheck /></span>
      <OptionCopy option={option} />
    </button>
  );
}

function OptionCopy({ option }: { option: FormOption }) {
  return (
    <span className="qf-chip-copy">
      <span>{option.label}</span>
      {option.description ? <span className="qf-chip-desc">{option.description}</span> : null}
    </span>
  );
}

/**
 * 叠放态的手势常量，逐个取自交付稿 `docs/design/chat-panel-next.html` 里
 * 那段 `visual-fan` 脚本：拖过 `THROW` 就当你要翻页，剩下的路交给动效；
 * 位移小于 `TAP` 压根不算拖，让它照常当点击（选中一张仍然靠点）。
 */
const VISUAL_STACK_THROW = 56;
const VISUAL_STACK_TAP = 6;
/** 甩出去那一下的时长，到点才把卡排到队尾 —— 直接换顺序会让它从手上瞬移。 */
const VISUAL_STACK_THROW_MS = 190;

/** 叠成一沓（默认）/ 铺成网格。右上角那枚开关在两者之间切。 */
type VisualStyleView = 'fan' | 'grid';

/*
 * **画廊弹窗已整体退场**(B53,2026-08-27)。
 *
 * 它原来的入口是卡片条末尾那颗 `+N`(`.qf-visual-more`),干的是「这一页只放得下 4 张,
 * 其余的到弹窗里翻」——**分页时代的溢出面**。2026-08-26 裁决「整份目录进一沓」把分页撤掉,
 * `+N` 跟着退场,`openGallery()` 就此没有任何调用点,弹窗连同它的分类页签
 * (All / Business / Editorial / Creative / Minimal)在正常流程里再也打不开。
 *
 * 收敛方向按交付稿定:`docs/design/chat-matrix/matrix-82.html` 第 #21 / #22 格底栏
 * **只有** `换一批 / 随机 / 下一步` 三个动作;稿子里的「铺开」是选项区右上角那枚
 * `.vbar > .vswitch`(`aria-label="铺成网格"`),把 `data-view` 在 `fan` / `grid`
 * 之间切,**是内联的**,不是弹窗 —— 也就是这里的 `[data-action="toggle-view"]`。
 * 全稿 84 格里唯一的 `role="dialog"` 是「联系支持」。
 *
 * 「看全部」这件事没丢(`chat-panel-feedback.md` §C:「不能因为稿子是 4 张就不做看全部」)——
 * 一次铺开整份目录,比弹窗里再分五个页签更直接。
 *
 * **一并去掉的**:`visual_style_gallery_open` / `visual_style_category_tab` 两个埋点、
 * `interaction_source` 的 `'gallery'` 一档、`category_id` 参数、`.qf-visual-dialog*` 那族样式。
 *
 * **要产品拍的一条**(已写进 `specs/current/chat-panel-feedback.md` 的 B53 行):
 * 自定义答案的输入框原来只长在这个弹窗里,跟着一起没了。稿子的视觉方向卡本来就没有
 * 「自己填」(#20 那种文字多选才有),而 `direction-cards` 那条路一直就没有 ——
 * 所以这里按稿子实现,不自造一个稿子上没有的输入位。
 */

function VisualStylePicker({
  cards,
  context,
  formId,
  questionId,
  value,
  disabled,
  selectionMode,
  maxSelections,
  onChange,
  onInteraction,
  submitSlot,
}: {
  cards: VisualStyleCard[];
  context: VisualStyleContext;
  formId: string;
  questionId: string;
  value: string[];
  disabled: boolean;
  selectionMode: 'single' | 'multiple';
  maxSelections?: number;
  onChange: (value: string[]) => void;
  onInteraction?: (interaction: QuestionFormInteraction) => void;
  /**
   * 稿子第 21 / 22 格的底栏是**一行**,逐颗核对过只有三个动作:
   * `换一批 | 随机 | 下一步`(#21 那格「下一步」是 `disabled`)。**没有第四颗** ——
   * 「铺开 / 撑开」不在底栏,是选项区右上角那枚 `.vbar > .vswitch`(见 `VisualDirectionStack`)。
   * 「下一步」由外层 `QuestionFormView` 造好交下来 —— 它只依赖那边的 `handleSubmit` / `ready`;
   * 反过来把「换一批 / 随机」提上去就要搬走翻牌、重置这一沓、还剩几张一整套状态。
   */
  submitSlot?: ReactNode;
}) {
  const t = useT();
  /*
   * 这一沓里放的是【这一批的 6 张】,不是整份目录(2026-08-27 产品口径:
   * 「点击换一批时,顺序从 22 个里每次挑 6 个出来」)。挑哪 6 张、
   * 「换一批」怎么换、选中的那张怎么钉住,全在 `runtime/visual-style-deck.ts`,
   * 那边有逐条的理由和单测。
   *
   * `batchHint` 只是【提示】不是真相:每次渲染都要 `resolveVisualStyleBatch`
   * 修一遍 —— 目录可能换了(切换产物类型),「随机」也可能从整份目录里
   * 抽中一张不在牌面上的卡,那张必须被拉进来,不然用户抽中了却看不见、取消不掉。
   */
  const allValues = cards.map((card) => card.value);
  /*
   * 【首屏就要有一份真的牌面】,不能拿 `null` 当起点。
   *
   * `resolveVisualStyleBatch` 在没有上一批可参照时,只能把选中的值塞进**第一个空槽**——
   * 于是「取消选择」会当场把那张卡挪到槽 0,牌面跟着重排,用户点下去的那一下
   * 看起来像没生效(实测:选满两张再取消第一张,第二张会跳到最前面,而它是选中的,
   * 于是最前面那张仍然带着勾)。存一份初始牌面之后,`current` 永远是真的,
   * 钉住的那张就只会待在它自己的槽里。
   */
  const [batchHint, setBatchHint] = useState<string[]>(() =>
    resolveVisualStyleBatch({ all: allValues, current: null, keep: value }),
  );
  /** 下一次「换一批」从目录的第几张开始补。 */
  const [cursor, setCursor] = useState(0);
  /** 换过一批 / 替人随机挑过之后，把这一沓翻回第一张 —— 见 VisualDirectionStack。 */
  const [stackResetToken, setStackResetToken] = useState(0);
  /** 「随机」抽中的那张 —— 交给这一沓翻到最前面(见 `pickRandomStyle`) */
  const [revealValue, setRevealValue] = useState<string | undefined>(undefined);
  const customValue =
    value.find((candidate) => !cards.some((card) => card.value === candidate)) ?? '';
  const byValue = new Map(cards.map((card) => [card.value, card] as const));
  const batchValues = resolveVisualStyleBatch({
    all: allValues,
    current: batchHint,
    keep: value,
  });
  const compactCards = batchValues
    .map((candidate) => byValue.get(candidate))
    .filter((card): card is VisualStyleCard => card !== undefined);

  /** 每张卡交给叠放外壳的那一份：值、方向名、预览面，以及自己能不能点。 */
  const stackOptions: VisualDirectionOption[] = compactCards.map((card) => ({
    value: card.value,
    title: card.title,
    preview: (
      <VisualStylePreview
        context={context}
        variant={card.variant}
        preview={card.preview}
        eager={!disabled}
      />
    ),
    disabled:
      disabled ||
      (selectionMode === 'multiple' &&
        !value.includes(card.value) &&
        maxSelections !== undefined &&
        value.length >= maxSelections),
  }));

  function shuffle() {
    // 目录还不够一批的时候没得换 —— 牌面上本来就是全部
    if (cards.length <= VISUAL_STYLE_BATCH_SIZE) return;
    onInteraction?.({
      element: 'visual_style_refresh',
      questionId,
      styleContext: context,
    });
    const next = rotateVisualStyleBatch({
      all: allValues,
      current: batchValues,
      keep: value,   // 选中的那张钉住:轮走了就再也点不到,于是取消不掉
      cursor,
    });
    setBatchHint(next.batch);
    setCursor(next.cursor);
    /* 翻页位置归零 —— 不然新的一批还压在旧的翻页位置上,最前面那张是第三张。
       `revealValue` 也要清掉:它是「随机」留下的,不清的话这一沓会去找一张
       可能已经不在牌面上的卡。 */
    setRevealValue(undefined);
    setStackResetToken((current) => current + 1);
  }

  /** 「随机」：替人挑一张没选过的，顺手把这一沓翻回第一张，不然选完还压在底下。 */
  function pickRandomStyle() {
    if (cards.length === 0) return;
    const unpicked = cards.filter((card) => !value.includes(card.value));
    const pool = unpicked.length > 0 ? unpicked : cards;
    const card = pool[Math.floor(Math.random() * pool.length)];
    if (!card) return;
    selectStyle(card);
    /*
     * 把随机选中的那张**翻到最前面**,不然选完它还压在底下,用户看不见自己抽到了什么。
     *
     * 光 bump token 不够 —— `VisualDirectionStack` 的那个 effect 是拿 `revealValue`
     * 去找下标的,没给就 `at = -1`,于是弹回第一张。这里原来漏了 `revealValue`,
     * 一沓只有 4 张时碰巧看不出来(概率 1/4 撞对),整份目录进来之后就露馅了。
     */
    setRevealValue(card.value);
    setStackResetToken((current) => current + 1);
  }

  function selectStyle(card: VisualStyleCard) {
    onInteraction?.({
      element: 'visual_style_card',
      questionId,
      styleId: card.value,
      styleContext: context,
      source: 'inline',
    });
    if (selectionMode === 'single') {
      onChange([card.value]);
      return;
    }
    if (value.includes(card.value)) {
      onChange(value.filter((candidate) => candidate !== card.value));
      return;
    }
    if (maxSelections !== undefined && value.length >= maxSelections) return;
    onChange([...value, card.value]);
  }

  const reshuffleAction = (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      className="qf-visual-foot-action"
      data-action="reshuffle"
      disabled={disabled || cards.length <= VISUAL_STYLE_BATCH_SIZE}
      onClick={shuffle}
    >
      {t('qf.visualReshuffle')}
    </Button>
  );
  const decideActions = (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="qf-visual-foot-action"
        data-action="random"
        disabled={disabled || cards.length === 0}
        onClick={pickRandomStyle}
      >
        {t('qf.visualRandom')}
      </Button>
      {/* 「+N」那颗删掉:整份目录已经在这一沓里了,右上角那枚四方块负责摊开看全部
          (2026-08-26 裁决) */}
    </>
  );
  return (
    <VisualDirectionStack
      artifactType={context}
      options={stackOptions}
      formId={formId}
      questionId={questionId}
      values={value}
      disabled={disabled}
      inputType={selectionMode === 'single' ? 'radio' : 'checkbox'}
      revealToken={stackResetToken}
      revealValue={revealValue}
      onSelect={(option) => {
        const card = cards.find((candidate) => candidate.value === option.value);
        if (card) selectStyle(card);
      }}
      footer={
        <>
          {reshuffleAction}
          <span className="qf-visual-foot-gap" />
          {decideActions}
          {/* 稿子里「下一步」和这两颗在**同一行**;它由外层交下来(见 `submitSlot`) */}
          {submitSlot}
        </>
      }
    >
      {/*
        目录里没有的那个答案(模型给的 `defaultValue`,或上一轮存下来的草稿)。
        它原来是一颗 `<button>` —— 点开画廊弹窗、在里面改。弹窗退场之后那扇门就不存在了,
        再留一颗按不出反应的按钮才是真的死码,所以整项降成**一句陈述**。
      */}
      {customValue ? (
        <span className="qf-visual-custom-summary">
          <Icon name="check" size={12} />
          <span>{customValue}</span>
        </span>
      ) : null}
    </VisualDirectionStack>
  );
}

/** 交给叠放外壳的一张卡：值、压在图左下角的方向名、预览面。 */
interface VisualDirectionOption {
  value: string;
  title: string;
  /** 预览面。目录卡给真图，agent 自己开的方向卡给占位块（见 `VisualDirectionPlaceholder`）。 */
  preview: ReactNode;
  disabled?: boolean;
}

/**
 * 视觉方向的排布外壳 —— 交付稿第 21 / 22 格（`.opts.mod-visual`）那一套。
 *
 * 风格这类问题不能用文字选项：抽象词说不清，所以这一格给的是图。默认把几张
 * 预览【叠成一沓】：这是问一句、问完就收走的东西，不该是这一屏最大的一块；
 * 左右箭头或直接拖着翻，右上角那枚开关铺成网格挨个比。
 *
 * 两个调用方共用它：目录驱动的 `VisualStylePicker`，和 agent 自己在表单里
 * 开的 `direction-cards`。它只管排布、翻页和勾选，不碰数据来源与提交逻辑。
 */
function VisualDirectionStack({
  options,
  formId,
  questionId,
  values,
  disabled,
  inputType,
  artifactType,
  revealToken,
  revealValue,
  footer,
  children,
  onSelect,
}: {
  options: VisualDirectionOption[];
  formId: string;
  questionId: string;
  values: string[];
  disabled: boolean;
  inputType: 'radio' | 'checkbox';
  artifactType?: string;
  /**
   * 这个数一变，就把 `revealValue` 那张翻到最前面（没给就翻回第一张）。
   * 「换一批」和「随机」都要用：替人挑完还压在底下看不见，等于没挑。
   */
  revealToken?: number;
  revealValue?: string;
  /** 页脚那一行的动作(稿子 #21 / #22:换一批 / 随机 / 下一步)。「看全部」不在这里 ——
      它是上面那枚 `.qf-visual-switch`,一下铺开整份目录。 */
  footer?: ReactNode;
  onSelect: (option: VisualDirectionOption) => void;
  children?: ReactNode;
}) {
  const t = useT();
  const [view, setView] = useState<VisualStyleView>('fan');
  /** 这一沓当前谁在最前面 —— 左右箭头和拖拽都只改这个数，位置一律交回 CSS。 */
  const [stackStart, setStackStart] = useState(0);
  const stackRef = useRef<HTMLDivElement | null>(null);
  const draggedRef = useRef(false);
  const throwTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /* 只在 token 变的那一下读一次当前的牌面，不把它们挂进依赖里 —— 挂进去的话
     每次重排都会把这一沓弹回去，人手动翻的那几下就白翻了。 */
  const revealRef = useRef({ options, revealValue });
  revealRef.current = { options, revealValue };

  useEffect(() => {
    const { options: current, revealValue: wanted } = revealRef.current;
    const at = wanted ? current.findIndex((option) => option.value === wanted) : -1;
    setStackStart(at > 0 ? at : 0);
  }, [revealToken]);
  useEffect(
    () => () => {
      if (throwTimerRef.current !== null) clearTimeout(throwTimerRef.current);
    },
    [],
  );

  const stackOptions = rotateVisualStack(options, stackStart);

  /**
   * 翻这一沓。`delta` 为 1 是「下一张」（把最前面那张排到队尾），-1 是
   * 「上一张」（把队尾那张提到最前面）。箭头和拖拽走的是同一条路，所以
   * 两种操作走完的结果一定一致，不会各自算出一套位置来。
   */
  function stepStack(delta: 1 | -1) {
    if (options.length < 2) return;
    setStackStart((current) => (current + delta + options.length) % options.length);
  }

  /**
   * 叠放态里最前面那张可以拖着翻。不用拖满全程 —— 超过阈值就当你要翻，剩下
   * 的路由动效走完（和真机上甩卡一样）；位移不够就弹回原位，小于 TAP 更是
   * 压根不算拖，让它照常当点击：选中一张仍然靠点。
   */
  function handleStackPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    draggedRef.current = false;
    if (disabled || view !== 'fan' || options.length < 2) return;
    const stack = stackRef.current;
    const target =
      event.target instanceof Element ? event.target.closest('.qf-visual-card') : null;
    if (!stack || !(target instanceof HTMLElement)) return;
    if (target !== stack.firstElementChild) return;

    const startX = event.clientX;
    const startY = event.clientY;
    let dx = 0;
    let dy = 0;
    let moved = false;

    const settle = () => {
      target.style.transition = '';
      target.style.transform = '';
      target.style.zIndex = '';
    };

    const onMove = (moveEvent: PointerEvent) => {
      dx = moveEvent.clientX - startX;
      dy = moveEvent.clientY - startY;
      if (!moved && Math.hypot(dx, dy) < VISUAL_STACK_TAP) return;
      moved = true;
      draggedRef.current = true;
      target.style.transition = 'none';
      target.style.transform = `translate(${dx}px, ${dy}px) rotate(${dx / 22}deg)`;
      target.style.zIndex = '9';
    };

    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
      if (!moved) return;
      // 交回给 CSS 那条 transform 过渡
      target.style.transition = '';
      if (Math.hypot(dx, dy) <= VISUAL_STACK_THROW) {
        settle();
        return;
      }
      if (prefersReducedMotion()) {
        settle();
        stepStack(1);
        return;
      }
      target.style.transform = `translate(${dx * 2.2}px, ${dy * 2.2}px) rotate(${dx / 10}deg)`;
      // 收尾用定时器而不是 transitionend：甩出去这一下若被边界情形吃掉，
      // transitionend 永远不来，那张卡就卡在手上了。
      throwTimerRef.current = setTimeout(() => {
        throwTimerRef.current = null;
        settle();
        stepStack(1);
      }, VISUAL_STACK_THROW_MS);
    };

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
  }

  /** 拖完手指抬起来那一下浏览器还会补一个 click —— 别让它顺手选中这张卡。 */
  function handleStackClickCapture(event: ReactMouseEvent<HTMLDivElement>) {
    if (!draggedRef.current) return;
    draggedRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  }

  const switchLabel = view === 'fan' ? t('qf.visualViewGrid') : t('qf.visualViewFan');

  return (
    <div
      className="qf-visual-picker"
      data-artifact-type={artifactType}
      data-question-id={questionId}
      data-testid="question-form-visual-picker"
      data-view={view}
    >
      {/* 顶部那一条只放视图切换，不放别的 —— 再挂标题或计数就成了卡里的第二个
          卡头。图标画的是【点下去会变成什么】，不是现在是什么。 */}
      <div className="qf-visual-bar">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="qf-visual-switch"
          data-action="toggle-view"
          disabled={disabled}
          onClick={() => setView((current) => (current === 'fan' ? 'grid' : 'fan'))}
          title={switchLabel}
          aria-label={switchLabel}
        >
          {view === 'fan' ? <Icon name="grid-4" size={15} /> : <VisualStackIcon />}
        </Button>
      </div>
      <div className="qf-visual-stage">
        <div
          className="qf-visual-stack"
          ref={stackRef}
          onPointerDown={handleStackPointerDown}
          onClickCapture={handleStackClickCapture}
        >
          {stackOptions.map((option, index) => (
            <VisualDirectionCardView
              key={option.value}
              option={option}
              formId={formId}
              questionId={questionId}
              selected={values.includes(option.value)}
              disabled={option.disabled === true}
              inputType={inputType}
              /* 叠放态里只有最前面那张露在外面，后面几张不该抢走 Tab 焦点 */
              tabbable={view === 'grid' || index === 0}
              onSelect={() => onSelect(option)}
            />
          ))}
        </div>
        {view === 'fan' && options.length > 1 ? (
          <div className="qf-visual-nav">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="qf-visual-nav-button"
              data-nav="prev"
              disabled={disabled}
              title={t('qf.visualPrev')}
              aria-label={t('qf.visualPrev')}
              onClick={() => stepStack(-1)}
            >
              <Icon name="chevron-left" size={15} />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="qf-visual-nav-button"
              data-nav="next"
              disabled={disabled}
              title={t('qf.visualNext')}
              aria-label={t('qf.visualNext')}
              onClick={() => stepStack(1)}
            >
              <Icon name="chevron-right" size={15} />
            </Button>
          </div>
        ) : null}
      </div>
      {/* 页脚不铺底色也不画线 —— 它靠位置说话。稿子在这一格里多给了「换一批」
          「随机」两个出口：挑图这件事本来就该有「都不喜欢」和「帮我决定」。 */}
      {footer ? <div className="qf-visual-foot">{footer}</div> : null}
      {children}
    </div>
  );
}

/**
 * 把 `cards` 转成叠放态的显示顺序 —— `start` 之前的挪到队尾。
 * 位置本身全由 CSS 的 `nth-child` 决定，这里只负责谁排第几。
 */
function rotateVisualStack<T>(cards: T[], start: number): T[] {
  if (cards.length < 2) return cards;
  const at = ((start % cards.length) + cards.length) % cards.length;
  return at === 0 ? cards : [...cards.slice(at), ...cards.slice(0, at)];
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** 稿子里那枚「叠回一沓」的图标：一张卡在前、一张在后。路径逐字取自交付稿。 */
function VisualStackIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      aria-hidden
    >
      <rect x="8.5" y="3.5" width="11.5" height="15.5" rx="2" />
      <path d="M5.5 6.5v11a2.5 2.5 0 0 0 2.5 2.5h8" />
    </svg>
  );
}

function VisualDirectionCardView({
  option,
  formId,
  questionId,
  selected,
  disabled,
  inputType,
  tabbable,
  onSelect,
}: {
  option: VisualDirectionOption;
  formId: string;
  questionId: string;
  selected: boolean;
  disabled: boolean;
  inputType: 'radio' | 'checkbox';
  /** 叠放态里被压在下面的那几张不参与 Tab 序 —— 它们在视觉上还没露出来。 */
  tabbable?: boolean;
  onSelect: () => void;
}) {
  /*
   * 交付稿 `.vopt`:
   *   <button class="vopt" type="button">
   *     <span class="vpv"><span class="pick"><svg class="ck"/></span>…预览…</span>
   *     <span class="vmeta"><span class="vt">克制留白</span></span>
   *   </button>
   *
   * 原来是 `<label>` 套一枚隐藏的 `<input>`,勾和名字都直接贴在卡上(没有 `.vpv` / `.vmeta` 两层)。
   * 和固定选项同一条(D52):标签不一样,逐元素比样式时整段串位。
   * 可达性同样用 ARIA 补:自己声明 role + aria-checked,回车/空格都能选。
   */
  return (
    <button
      type="button"
      role={inputType === 'checkbox' ? 'checkbox' : 'radio'}
      aria-checked={selected}
      className={`qf-visual-card${selected ? ' qf-visual-card-on' : ''}${disabled ? ' qf-visual-card-disabled' : ''}`}
      title={option.title}
      disabled={disabled}
      tabIndex={tabbable === false ? -1 : undefined}
      onClick={onSelect}
    >
      <span className="qf-visual-card-preview">
        {/* 未选中也画空圈，不是选中才冒出来 —— 空圈在告诉人「这几张是可选的」。
            落绿勾靠 CSS 换成 --tick-img，和多选那一枚是同一张。 */}
        <span className="qf-visual-card-check" aria-hidden>
          <Icon name="check" size={12} />
        </span>
        {option.preview}
      </span>
      <span className="qf-visual-card-meta">
        <span className="qf-visual-card-name">{option.title}</span>
      </span>
    </button>
  );
}

/**
 * 没有预览图时的占位面。
 *
 * 一块纯灰压住图片该占的范围，不画内容 —— 这是占位不是效果图。稿子在这里
 * 把代价写明白了：四张会长得一样，「能不能比出风格差异」要等真图。
 * agent 自己开的 `direction-cards` 目前就走这一支（内置精选预览图是另一条
 * 待办）；素材到位后换掉这一层即可，外框、勾选圈、方向名都不用动。
 */
function VisualDirectionPlaceholder() {
  return <span className="qf-visual-preview qf-visual-preview-blank" aria-hidden />;
}

function VisualStylePreview({
  context,
  variant,
  preview,
  eager = false,
}: {
  context: VisualStyleContext;
  variant: VisualStyleCard['variant'];
  preview?: VisualStyleCard['preview'];
  /** The active six-card batch should be ready before a hidden card rotates forward. */
  eager?: boolean;
}) {
  if (preview) {
    return (
      <span className="qf-visual-preview" data-style={variant}>
        <img
          className="qf-visual-preview-image"
          src={preview.thumbnailSrc}
          alt={preview.alt}
          width={640}
          height={480}
          loading={eager ? 'eager' : 'lazy'}
          decoding="async"
        />
      </span>
    );
  }
  if (context === 'deck') {
    return (
      <span className="qf-visual-preview qf-visual-preview-deck" data-style={variant} aria-hidden>
        <span className="qf-preview-slide qf-preview-slide-hero">
          <span className="qf-preview-kicker" />
          <span className="qf-preview-title" />
          <span className="qf-preview-title qf-preview-title-short" />
          <span className="qf-preview-accent" />
        </span>
        <span className="qf-preview-slide qf-preview-slide-copy">
          <span className="qf-preview-copy-lines">
            <i />
            <i />
            <i />
          </span>
          <span className="qf-preview-figure" />
        </span>
        <span className="qf-preview-slide qf-preview-slide-data">
          <span className="qf-preview-chart">
            <i />
            <i />
            <i />
            <i />
          </span>
        </span>
      </span>
    );
  }
  return (
    <span className="qf-visual-preview qf-visual-preview-prototype" data-style={variant} aria-hidden>
      <span className="qf-preview-app">
        <span className="qf-preview-appbar">
          <i />
          <i />
          <i />
        </span>
        <span className="qf-preview-app-body">
          <span className="qf-preview-sidebar">
            <i />
            <i />
            <i />
          </span>
          <span className="qf-preview-content">
            <span className="qf-preview-content-head" />
            <span className="qf-preview-content-grid">
              <i />
              <i />
              <i />
            </span>
            <span className="qf-preview-content-list">
              <i />
              <i />
            </span>
          </span>
        </span>
      </span>
    </span>
  );
}

/**
 * agent 自己在表单里开的「视觉方向」（`direction-cards`）。
 *
 * 和目录驱动的 `VisualStylePicker` 共用同一套排布外壳（交付稿第 21 / 22 格）：
 * 默认叠成一沓、左右箭头或拖着翻、右上角切成网格。区别只在两处 ——
 *  · 预览面是占位块：这批卡是 agent 现场开的，没有素材（真图是另一条待办）；
 *  · 页脚只给「随机」：卡就这么几张，没有「下一批」可换。
 *
 * 卡上不再画色板 / Aa 字样 / mood / 参考名（D45 按新稿作废）：稿子的理由是
 * 「方向名底下不挂一句描述」—— 这张卡存在的前提就是抽象词说不清所以给你看图，
 * 再补一段文字等于承认图没说清。`palette` / `mood` / `references` 仍在数据里，
 * 只是这一版不展示。
 */
function DirectionCardsPicker({
  cards,
  formId,
  questionId,
  value,
  disabled,
  onSelect,
}: {
  cards: DirectionCard[];
  formId: string;
  questionId: string;
  value: string;
  disabled: boolean;
  onSelect: (cardId: string) => void;
}) {
  const t = useT();
  /** 「随机」替人挑完之后，要把挑中的那张翻到最前面 —— 见 VisualDirectionStack。 */
  const [reveal, setReveal] = useState<{ token: number; value?: string }>({ token: 0 });
  const options: VisualDirectionOption[] = cards.map((card) => ({
    value: card.id,
    title: card.label,
    preview: <VisualDirectionPlaceholder />,
    disabled,
  }));
  /* 提交回来的值可能是卡的 id，也可能是它的标题 —— 两种都算选中这一张。 */
  const selected = cards.find((card) => card.id === value || card.label === value);

  return (
    <VisualDirectionStack
      options={options}
      formId={formId}
      questionId={questionId}
      values={selected ? [selected.id] : []}
      disabled={disabled}
      inputType="radio"
      revealToken={reveal.token}
      revealValue={reveal.value}
      onSelect={(option) => onSelect(option.value)}
      footer={
        <>
          <span className="qf-visual-foot-gap" />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="qf-visual-foot-action"
            data-action="random"
            disabled={disabled || cards.length === 0}
            onClick={() => {
              const pool = cards.filter((card) => card.id !== selected?.id);
              const pick = (pool.length > 0 ? pool : cards)[
                Math.floor(Math.random() * (pool.length > 0 ? pool.length : cards.length))
              ];
              if (!pick) return;
              onSelect(pick.id);
              setReveal((current) => ({ token: current.token + 1, value: pick.id }));
            }}
          >
            {t('qf.visualRandom')}
          </Button>
        </>
      }
    />
  );
}

function buildInitialState(
  form: QuestionForm,
  submitted: Record<string, string | string[]> | undefined,
  draft: Record<string, string | string[]> | undefined,
  visualStyleContext: VisualStyleContext | undefined,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const q of form.questions) {
    if (submitted && submitted[q.id] !== undefined) {
      out[q.id] = canonicalizeQuestionValue(q, submitted[q.id]!, visualStyleContext);
      continue;
    }
    if (draft && draft[q.id] !== undefined && q.type !== 'file') {
      out[q.id] = canonicalizeQuestionValue(q, draft[q.id]!, visualStyleContext);
      continue;
    }
    if (q.defaultValue !== undefined) {
      out[q.id] = canonicalizeQuestionValue(q, q.defaultValue, visualStyleContext);
      continue;
    }
    out[q.id] = emptyQuestionValue(q);
  }
  return out;
}

/**
 * Whether a question that already holds a value should adopt a
 * later-arriving streamed `default`.
 *
 * The partial-JSON parser reveals a question as soon as its label lands, but
 * models are free to emit the `default` key after `options` — so the reveal
 * pass can park a question on its auto-assigned empty value before the
 * recommendation has streamed in. Invariant: a late default fills a question
 * only while (a) the user has never touched it and (b) it still holds that
 * auto-assigned empty value, so it can never clobber a real answer or an
 * intentional clear.
 */
function shouldAdoptStreamedDefault(
  q: QuestionForm['questions'][number],
  current: string | string[],
  touched: ReadonlySet<string>,
): boolean {
  if (q.defaultValue === undefined || touched.has(q.id)) return false;
  if (Array.isArray(current)) return current.length === 0;
  return current === emptyQuestionValue(q);
}

function draftSafeAnswers(
  form: QuestionForm,
  answers: Record<string, string | string[]>,
): Record<string, string | string[]> {
  const fileQuestionIds = new Set(
    form.questions.filter((q) => q.type === 'file').map((q) => q.id),
  );
  if (fileQuestionIds.size === 0) return answers;
  const out: Record<string, string | string[]> = {};
  for (const [id, value] of Object.entries(answers)) {
    if (!fileQuestionIds.has(id)) out[id] = value;
  }
  return out;
}

function answersWithSkippedQuestions(
  form: QuestionForm,
  answers: Record<string, string | string[]>,
  skippedQuestionIds: ReadonlySet<string>,
): Record<string, string | string[]> {
  if (skippedQuestionIds.size === 0) return answers;
  const submittedAnswers = { ...answers };
  for (const q of form.questions) {
    if (skippedQuestionIds.has(q.id)) {
      submittedAnswers[q.id] = emptyQuestionValue(q);
    }
  }
  return submittedAnswers;
}

function collectFileSubmissions(
  form: QuestionForm,
  fileAnswers: Record<string, File[]>,
  skippedQuestionIds: ReadonlySet<string>,
): QuestionFormFileSubmission[] {
  const out: QuestionFormFileSubmission[] = [];
  for (const q of form.questions) {
    if (q.type !== 'file' || skippedQuestionIds.has(q.id)) continue;
    const files = fileAnswers[q.id] ?? [];
    if (files.length === 0) continue;
    out.push({ questionId: q.id, questionLabel: q.label, files });
  }
  return out;
}

function emptyQuestionValue(q: QuestionForm['questions'][number]): string | string[] {
  if (q.type === 'checkbox') return [];
  if (q.type === 'switch') return 'false';
  if (q.type === 'range') return String(q.min ?? 0);
  if (q.type === 'color') return normalizeColorInputValue('');
  return '';
}

function formWithVisualStyleOptions(
  form: QuestionForm,
  visualStyleContext: VisualStyleContext | undefined,
): QuestionForm {
  if (!visualStyleContext) return form;
  let expanded = false;
  const questions = form.questions.map((question) => {
    if (!questionUsesVisualStyleCatalog(question)) {
      return question;
    }
    expanded = true;
    return {
      ...question,
      options: visualStyleCardsForContext(visualStyleContext).map((card) => ({
        label: card.title,
        value: card.value,
        description: card.description,
        foundationDirectionId: visualStyleFoundationDirectionId(card.variant),
        agentGuidance: card.description,
      })),
    };
  });
  return expanded ? { ...form, questions } : form;
}

/**
 * 有选项的问题必须先有答案(稿子 5-1 / 5-3 / 5-4);自由输入不在这条规则里 ——
 * 稿子没画过那种卡,不该顺手把它也收紧。`required` 仍然独立成立。
 */
const CHOICE_QUESTION_TYPES = new Set(['radio', 'checkbox', 'direction-cards']);
function questionNeedsAnswer(q: QuestionForm['questions'][number]): boolean {
  return q.required === true || CHOICE_QUESTION_TYPES.has(q.type);
}

/**
 * 这道题算不算「答了」。
 *
 * 数组要**逐条** trim:多选把「自己填」的文字放进同一个数组,
 * 一个空白条目不能算一条答案(稿子 5-4:开了输入框没写字,「下一步」仍置灰)。
 */
function questionAnswerIsPresent(value: string | string[] | undefined): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => typeof entry === 'string' && entry.trim().length > 0);
  }
  return typeof value === 'string' && value.trim().length > 0;
}

function canonicalizeQuestionValue(
  q: QuestionForm['questions'][number],
  value: string | string[],
  visualStyleContext: VisualStyleContext | undefined,
): string | string[] {
  /*
   * 值进状态只有这一个入口(提交历史 / 草稿 / 模型默认值三条路都从这儿过),
   * 所以颜色的规范化挂在这里就够了 —— 实现本身仍在 `normalizeHexColor` 一处。
   * 规范不出来的旧值**原样留着**:回放不许改写已经写下的内容。
   */
  if (q.type === 'color' && typeof value === 'string') {
    return normalizeHexColor(value) ?? value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) =>
      normalizeVisualStyleQuestionValue(q, entry, visualStyleContext),
    );
  }
  return normalizeVisualStyleQuestionValue(q, value, visualStyleContext);
}

const LEGACY_VISUAL_STYLE_VARIANTS: Readonly<Record<string, VisualStyleVariant>> = {
  editorial: 'editorial',
  'editorial / magazine': 'editorial',
  magazine: 'editorial',
  minimal: 'minimal',
  'modern minimal': 'minimal',
  'modern-minimal': 'minimal',
  'soft gradients': 'minimal',
  'soft-gradient': 'minimal',
  'soft-gradients': 'minimal',
  playful: 'playful',
  'playful / illustrative': 'playful',
  illustrative: 'playful',
  utility: 'utility',
  'tech / utility': 'utility',
  tech: 'utility',
  luxury: 'luxury',
  'luxury / refined': 'luxury',
  refined: 'luxury',
  brutalist: 'brutalist',
  experimental: 'brutalist',
  human: 'human',
  'human / approachable': 'human',
  approachable: 'human',
};

/**
 * Maps the original seven tone aliases to the full catalog's stable card
 * IDs. Unknown/custom answers deliberately pass through unchanged.
 */
export function normalizeVisualStyleQuestionValue(
  q: QuestionForm['questions'][number],
  value: string,
  visualStyleContext: VisualStyleContext | undefined,
): string {
  const optionValue = formOptionValueForLabel(q, value);
  if (!visualStyleContext || !questionUsesVisualStyleCatalog(q)) {
    return optionValue;
  }

  const cards = visualStyleCardsForContext(visualStyleContext);
  const normalized = optionValue.trim().toLocaleLowerCase();
  const directMatch = cards.find(
    (card) =>
      card.value.toLocaleLowerCase() === normalized ||
      card.title.toLocaleLowerCase() === normalized,
  );
  if (directMatch) return directMatch.value;

  const variant = LEGACY_VISUAL_STYLE_VARIANTS[normalized];
  return variant
    ? (cards.find((card) => card.variant === variant)?.value ?? optionValue)
    : optionValue;
}

function questionUsesVisualStyleCatalog(
  question: QuestionForm['questions'][number],
): boolean {
  return question.type === 'direction-cards' || (
    question.id === 'tone' &&
    (question.type === 'checkbox' || question.type === 'radio') &&
    !!question.options
  );
}

function shouldRenderCustomChoice(q: QuestionForm['questions'][number]): boolean {
  return q.allowCustom !== false;
}

function questionValueIsKnown(q: QuestionForm['questions'][number], value: string): boolean {
  if (q.options?.some((option) => option.value === value || option.label === value)) return true;
  if (q.cards?.some((card) => card.id === value || card.label === value)) return true;
  return false;
}

/**
 * 卡头数字数的是画面里勾中的选项行，不是提交协议里的数组项。
 *
 * 「自己填」无论暂时为空，还是被逗号拆成多条提交值，界面上都只有一行；恢复旧会话时
 * 重复/别名值也不能把同一行重复计算。视觉目录的稳定 card id 不在模型原始 options 里，
 * 但仍是普通的固定选项，必须逐张计数。
 */
function pickedCheckboxChoiceCount(
  q: QuestionForm['questions'][number],
  value: string | string[] | undefined,
  visualStyleContext: VisualStyleContext | undefined,
  ownChoiceOpen: boolean,
): number {
  if (q.type !== 'checkbox' || !Array.isArray(value)) return 0;

  const catalogValues = visualStyleContext && questionUsesVisualStyleCatalog(q)
    ? new Set(visualStyleCardsForContext(visualStyleContext).map((card) => card.value))
    : null;
  const fixedValues = new Set<string>();
  let hasCustomValue = false;

  for (const entry of value) {
    const normalized = entry.trim();
    if (!normalized) continue;
    const fixed = catalogValues
      ? catalogValues.has(normalized)
      : questionValueIsKnown(q, normalized);
    if (fixed) fixedValues.add(normalized);
    else hasCustomValue = true;
  }

  return fixedValues.size + (ownChoiceOpen || hasCustomValue ? 1 : 0);
}

function customSingleValue(
  q: QuestionForm['questions'][number],
  value: string | string[] | undefined,
): string {
  if (typeof value !== 'string' || value.length === 0) return '';
  return questionValueIsKnown(q, value) ? '' : value;
}

function customCheckboxValue(
  q: QuestionForm['questions'][number],
  value: string | string[] | undefined,
): string {
  if (!Array.isArray(value)) return '';
  return value.filter((entry) => !questionValueIsKnown(q, entry)).join(', ');
}

function splitCustomEntries(raw: string): string[] {
  return raw
    .split(/[\n,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizeColorInputValue(value: string | string[] | undefined): string {
  // 原生 `<input type="color">` 只接受 `#rrggbb`,给不出来就退回黑 —— 这是**渲染**
  // 兜底,不是答案:答案的规范化在 `normalizeHexColor` 那一处。
  return normalizeHexColor(value) ?? '#000000';
}

/** 在编文本让位给答案:删掉这道题的 key,显示重新以答案为准。 */
function clearDraftText(
  setter: (updater: (prev: Record<string, string>) => Record<string, string>) => void,
  id: string,
): void {
  setter((prev) => {
    if (!(id in prev)) return prev;
    const next = { ...prev };
    delete next[id];
    return next;
  });
}

/**
 * 交付稿那八颗预设色。
 *
 * 这里**允许**出现字面 hex —— 它们是「被选的内容」本身(用户挑的是这个颜色),
 * 不是界面用色。界面用色仍旧走产品 token,一个都没有写死在这儿。
 * 模型自己在 `options` 里给了色值时以模型的为准,这份只是缺省调色板。
 */
const DEFAULT_COLOR_PRESETS = [
  '#ef4444',
  '#f97316',
  '#eab308',
  '#22c55e',
  '#3b82f6',
  '#8b5cf6',
  '#ec4899',
  '#64748b',
] as const;

function colorPresetsFor(q: QuestionForm['questions'][number]): string[] {
  const fromOptions: string[] = [];
  for (const option of q.options ?? []) {
    const canonical = normalizeHexColor(option.value);
    // 认不出来的选项直接丢掉,不拿一块黑去顶替 —— 那是在替模型编一个答案
    if (canonical && !fromOptions.includes(canonical)) fromOptions.push(canonical);
  }
  return fromOptions.length > 0 ? fromOptions : [...DEFAULT_COLOR_PRESETS];
}

/**
 * 颜色选择(交付稿 `.opts.mod-color`)——「预设色、系统取色器和 Hex 输入
 * 三条路实时同步,预览跟着更新」。
 *
 * 三条路共用**同一个**答案值,视图这一层不留第二份真相:预览色由包装层的
 * `--qf-choice-color` 驱动,色块的按下态、取色器的 value、Hex 框的显示值
 * 都从同一个 `color` 推出来。
 *
 * 色块的可读名就是它的 hex —— 稿子写的是「红色 #ef4444」那种「颜色名 + 值」,
 * 但我们没有一份 19 种语言的颜色名表,现编一份等于凭空造一套产品文案。
 * hex 本身是这颗色块**准确**的名字,不是近似。
 */
function ColorChoice({
  question,
  color,
  text,
  invalid,
  disabled,
  t,
  onPick,
  onType,
  onSettle,
}: {
  question: QuestionForm['questions'][number];
  color: string;
  text: string | undefined;
  invalid: boolean;
  disabled: boolean;
  t: ReturnType<typeof useT>;
  onPick: (raw: string) => void;
  onType: (raw: string) => void;
  onSettle: () => void;
}) {
  const presets = colorPresetsFor(question);
  const nativeId = `qf-color-native-${question.id}`;
  const errorId = `qf-color-error-${question.id}`;
  return (
    <div
      className="qf-color-field"
      style={{ '--qf-choice-color': color } as CSSProperties}
    >
      <fieldset className="qf-color-preset-field">
        <legend className="qf-color-legend">{t('qf.colorPresets')}</legend>
        <div className="qf-color-presets">
          {presets.map((preset) => (
            <button
              key={preset}
              type="button"
              className="qf-color-swatch"
              data-color={preset}
              aria-label={preset}
              aria-pressed={preset === color}
              disabled={disabled}
              style={{ '--qf-swatch': preset } as CSSProperties}
              onClick={() => onPick(preset)}
            />
          ))}
        </div>
      </fieldset>
      <div className="qf-color-custom-field">
        <label className="qf-color-legend" htmlFor={nativeId}>
          {t('qf.colorCustom')}
        </label>
        <div className="qf-color-custom">
          <input
            id={nativeId}
            type="color"
            className="qf-color"
            value={color}
            disabled={disabled}
            aria-label={t('qf.colorPickerLabel')}
            onChange={(e) => onPick(e.target.value)}
          />
          <input
            type="text"
            className="qf-color-hex"
            value={text ?? color}
            maxLength={7}
            spellCheck={false}
            autoComplete="off"
            disabled={disabled}
            aria-label={t('qf.colorHexLabel')}
            aria-invalid={invalid}
            {...(invalid ? { 'aria-describedby': errorId } : {})}
            onChange={(e) => onType(e.target.value)}
            onBlur={onSettle}
          />
        </div>
      </div>
      {invalid ? (
        <div className="qf-color-error" id={errorId} role="alert">
          {t('qf.colorInvalid')}
        </div>
      ) : null}
      <div className="qf-color-preview">{t('qf.colorPreview')}</div>
    </div>
  );
}

/*
 * 协议没给 min / max / step 时的兜底,取值**跟着 `<input type="range">` 的
 * HTML 默认走**(0 / 100 / 1)。这三个数不能自己另定一套:滑杆是原生控件,
 * 它照 HTML 默认把自己钉在 0–100;数字框那边若按「没有上界」放行,
 * 敲一个 500 进去就会出现「答案是 500、滑杆停在 100」的两份真相。
 */
const RANGE_FALLBACK_MIN = 0;
const RANGE_FALLBACK_MAX = 100;
const RANGE_FALLBACK_STEP = 1;

function rangeBounds(q: QuestionForm['questions'][number]): {
  min: number;
  max: number;
  step: number;
} {
  return {
    min: Number.isFinite(q.min) ? (q.min as number) : RANGE_FALLBACK_MIN,
    max: Number.isFinite(q.max) ? (q.max as number) : RANGE_FALLBACK_MAX,
    step:
      Number.isFinite(q.step) && (q.step as number) > 0
        ? (q.step as number)
        : RANGE_FALLBACK_STEP,
  };
}

/** 把一个数收进 `[min, max]` 并吸附到最近的 step 档。 */
function clampRangeValue(raw: number, q: QuestionForm['questions'][number]): number {
  const { min, max, step: stride } = rangeBounds(q);
  const snapped = min + Math.round((raw - min) / stride) * stride;
  const bounded = Math.min(max, Math.max(min, snapped));
  // step 是小数时(0.1 一档)会攒出 0.30000000000000004 这种尾巴,按 step 的
  // 小数位收一次 —— 这个数是要作为**文本**发回给模型的
  const decimals = (String(stride).split('.')[1] ?? '').length;
  return Number(bounded.toFixed(decimals));
}

/**
 * 数值滑块(交付稿 `.opts.mod-slider`)——「上方数字可直接编辑并与滑杆双向同步,
 * 不展示刻度点」。
 *
 * 两处**如实的偏差**,都是因为协议里没有对应字段(审计文档 §8 待决项 3):
 *  · 稿子数字后面那个「档」字是单位,我们没有单位 schema —— 整个不渲染,不臆造;
 *  · 稿子的端点是「1 · 疏朗 / 5 · 紧凑」,带着文案;我们只渲染 `min` / `max`
 *    两个数,那是协议里真有的东西。
 *
 * 旧数据不改写:历史里存着的越界标量(比如 1–5 的题里存了 7)在数字框里
 * **照原样念**,只有滑杆按物理范围收着显示。要改写得等用户自己动一下。
 */
function AmountChoice({
  question,
  answer,
  text,
  disabled,
  onDrag,
  onType,
  onSettle,
}: {
  question: QuestionForm['questions'][number];
  answer: string;
  text: string | undefined;
  disabled: boolean;
  onDrag: (raw: string) => void;
  onType: (raw: string) => void;
  onSettle: () => void;
}) {
  const { min, max } = rangeBounds(question);
  const parsed = Number(answer);
  const settled = answer.trim().length > 0 && Number.isFinite(parsed)
    ? clampRangeValue(parsed, question)
    : min;
  const readout = text ?? (answer.trim().length > 0 ? answer : String(settled));
  const pct = max > min ? ((settled - min) / (max - min)) * 100 : 0;
  return (
    <div
      className="qf-amount"
      style={{ '--qf-range-pct': `${pct}%` } as CSSProperties}
    >
      <div className="qf-amount-readout">
        <input
          type="number"
          className="qf-amount-value"
          value={readout}
          min={question.min}
          max={question.max}
          step={question.step}
          inputMode="numeric"
          aria-label={question.label}
          disabled={disabled}
          onChange={(e) => onType(e.target.value)}
          onBlur={onSettle}
        />
      </div>
      {/* 轨道里只放滑杆本身 —— 这一版稿子把上一版的 `.amount-stop` 光点整排删掉了 */}
      <div className="qf-amount-rail">
        <input
          type="range"
          className="qf-range"
          value={String(settled)}
          min={question.min}
          max={question.max}
          step={question.step}
          aria-label={question.label}
          disabled={disabled}
          onChange={(e) => onDrag(e.target.value)}
        />
      </div>
      <div className="qf-amount-limits" aria-hidden>
        <span>{min}</span>
        <span>{max}</span>
      </div>
    </div>
  );
}

/**
 * 多选计数(交付稿 `.selection-count` = `.count-label` + `.count-value`)。
 * 「已选」退后一档、数字保留原色,所以 DOM 上必须是两个元素。
 *
 * **不拿两个 key 前后拼**:`en` 是「2 picked」、`zh-CN` 是「已选 2」、
 * `ko` 是「2개 선택」(数字后面直接接字,中间没有空格)—— 拼接得钦定一种语序
 * 和一个分隔符,那三条里至少两条会错。
 *
 * 做法是把**同一条完整译文**按 `{count}` 的落点切开:切出来的两段天然就是
 * 这门语言自己的语序,空格也照译文原样留在段里。因此拼回去与整条译文逐字相等。
 */
/** 一个绝不会出现在任何译文里的哨兵,用来标记 `{count}` 的落点。 */
const PICKED_COUNT_SLOT = '\u0000';
function PickedCount({ t, count }: { t: ReturnType<typeof useT>; count: number }) {
  const rendered = t('qf.picked', { count: PICKED_COUNT_SLOT });
  const at = rendered.indexOf(PICKED_COUNT_SLOT);
  if (at === -1) {
    // 译文里没有 `{count}` 落点(译错了)。宁可整条照念,也不自己找地方插数字。
    return <span className="qf-picked">{t('qf.picked', { count })}</span>;
  }
  const before = rendered.slice(0, at);
  const after = rendered.slice(at + PICKED_COUNT_SLOT.length);
  return (
    <span className="qf-picked">
      {before ? <span className="qf-picked-label">{before}</span> : null}
      <span className="qf-picked-value">{count}</span>
      {after ? <span className="qf-picked-label">{after}</span> : null}
    </span>
  );
}

function fileValueLabel(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value.join(', ');
  return typeof value === 'string' ? value : '';
}

/**
 * Reverse of formatFormAnswers — when we render an old assistant message
 * that contained a form, look at the next user message in the conversation
 * to see if the form was already answered. If so, return the answers map
 * so the form renders in the locked "answered" state with the user's
 * picks visible.
 */
export function parseSubmittedAnswers(
  form: QuestionForm,
  userMessageContent: string,
): Record<string, string | string[]> | null {
  const lines = userMessageContent.split('\n').map((l) => l.trim());
  if (lines.length === 0) return null;
  const header = lines[0] ?? '';
  // We accept any "form answers" header so the agent can paraphrase.
  if (!/^\[form answers/i.test(header)) return null;
  const answers: Record<string, string | string[]> = {};
  const labelToId = new Map<string, string>();
  for (const q of form.questions) labelToId.set(q.label.toLowerCase(), q.id);
  const uploadSummaryIndex = lines.findIndex((line) => /^\[uploaded design files\]$/i.test(line));
  const answerLines = uploadSummaryIndex === -1 ? lines : lines.slice(0, uploadSummaryIndex);
  for (let i = 1; i < answerLines.length; i++) {
    const line = answerLines[i] ?? '';
    const m = /^[-*]\s*([^:]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    const labelKey = m[1]!.trim().toLowerCase();
    const value = m[2]!.trim();
    const id = labelToId.get(labelKey);
    if (!id) continue;
    const q = form.questions.find((x) => x.id === id);
    if (!q) continue;
    if (q.type === 'checkbox') {
      answers[id] = value
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0 && s.toLowerCase() !== '(skipped)')
        .map((s) => formOptionValueForLabel(q, parseSubmittedOptionToken(s)));
    } else {
      answers[id] = value.toLowerCase() === '(skipped)' ? '' : formOptionValueForLabel(q, parseSubmittedOptionToken(value));
    }
  }
  return Object.keys(answers).length > 0 ? answers : null;
}

function parseSubmittedOptionToken(raw: string): string {
  const match = /\s+\[value:\s*([^\]]+)\]\s*$/i.exec(raw);
  if (!match) return raw.trim();
  const valuePayload = match[1]!.trim();
  // A short-lived direction-card answer format carried Host metadata inside
  // the value token: `[value: host-id; foundation: …; guidance: …]`. Preserve
  // replay for answers created with that build while keeping the canonical
  // format's final `[value: host-id]` token machine-readable.
  const foundationOffset = valuePayload.search(/;\s*foundation\s*:/i);
  return (foundationOffset >= 0 ? valuePayload.slice(0, foundationOffset) : valuePayload).trim();
}

/**
 * 「已确认」陈述块 —— 交付稿 `.answered` 的 1:1 实现。
 *
 *   <div class="answered">
 *     <div class="k">已确认</div>
 *     <div class="ab"><span class="ak">商品卡</span><b>沿用列表页那张…</b></div>   ← 单值
 *     <ul class="al"><li><span class="ak">页面</span><b>商品详情页</b></li>…</ul>  ← 多值
 *   </div>
 *
 * **一处如实的偏差**:稿子里 `.ak` 是个很短的名词(「商品卡」/「页面」/「视觉方向」),
 * 而问题本身的文字是「设置页要不要沿用列表页的商品卡组件?」—— 也就是说稿子用的是
 * **另一个更短的字段**,我们的表单模型里没有它。这里先用问题的 `label`,
 * 结构与稿子一致、来源待产品定(见规格 §13 的待决项)。不臆造一个缩写规则。
 */
function AnsweredSummary({
  form,
  answers,
  visualStyleContext,
  t,
}: {
  form: QuestionForm;
  answers: Record<string, string | string[]>;
  visualStyleContext?: VisualStyleContext;
  t: ReturnType<typeof useT>;
}) {
  // This locked-form renderer follows design frame #24: each checkbox value
  // gets its own `.al li`. Conversation replay keeps its pre-existing compact
  // one-row-per-question shape from FormBlock.
  const summary = summarizeQuestionFormAnswers(form, answers, visualStyleContext, true);
  const flat = summary.items;
  const single = flat.length === 1 && summary.visualItems.length === 0;

  if (flat.length === 0 && summary.visualItems.length === 0) return null;

  return (
    <div className="answered">
      <div className="k">{t('qf.answeredConfirmed')}</div>
      {single ? (
        <div className={`ab${flat[0]!.swatch ? ' mod-value' : ''}`}>
          <span className="ak">{flat[0]!.label}</span>
          <AnsweredValue item={flat[0]!} />
        </div>
      ) : flat.length > 0 ? (
        <ul className="al">
          {flat.map((item) => (
            <li key={`${item.label}-${item.value}`}>
              <span className="ak">{item.label}</span>
              <AnsweredValue item={item} />
            </li>
          ))}
        </ul>
      ) : null}
      {summary.visualItems.map((item) => (
        <div key={item.label} className="ab">
          <span className="ak">{item.label}</span>
          <b>{item.cards.map((card) => card.title).join(' / ')}</b>
          {item.cards.map((card) => (
            <img
              key={card.src}
              className="av"
              src={card.src}
              alt={`${item.label}: ${card.title}`}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * 一条已确认答案的值。稿子里颜色那一条是
 * `<span class="color-answer" style="--answer-color:#3b82f6"><i></i><b>#3b82f6</b></span>`
 * —— 色块 + 规范化后的 Hex。规范不出来的旧值(历史里存着一句话)按纯文本念,
 * **不给它编一块颜色**。
 */
function AnsweredValue({ item }: { item: QuestionFormAnsweredSummary['items'][number] }) {
  if (!item.swatch) return <b>{item.value}</b>;
  return (
    <span
      className="color-answer"
      style={{ '--answer-color': item.swatch } as CSSProperties}
    >
      <i aria-hidden />
      <b>{item.value}</b>
    </span>
  );
}

export interface QuestionFormAnsweredSummary {
  items: Array<{ label: string; value: string; swatch?: string }>;
  visualItems: Array<{
    label: string;
    cards: Array<{ title: string; src: string }>;
  }>;
}

/**
 * Build the design's compact "Confirmed" rows from either the just-submitted
 * snapshot or a later replay. Both paths must resolve catalog-backed visual
 * choices the same way: the internal style id is protocol data, while the UI
 * shows the catalog title and its selected preview. `splitMultiValueItems`
 * preserves the locked-form design's one-row-per-checkbox-value layout; the
 * replay path keeps its established one-row-per-question summary.
 */
export function summarizeQuestionFormAnswers(
  form: QuestionForm,
  answers: Record<string, string | string[]>,
  visualStyleContext?: VisualStyleContext,
  splitMultiValueItems = false,
): QuestionFormAnsweredSummary {
  const items: QuestionFormAnsweredSummary['items'] = [];
  const visualItems: QuestionFormAnsweredSummary['visualItems'] = [];

  const readable = (question: QuestionForm['questions'][number], value: string): string => {
    const option = question.options?.find(
      (candidate) => candidate.value === value || candidate.label === value,
    );
    if (option) return option.label;
    const card = question.cards?.find(
      (candidate) => candidate.id === value || candidate.label === value,
    );
    return card?.label ?? value;
  };

  for (const question of form.questions) {
    const raw = answers[question.id];
    const values = (Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [])
      .filter((value) => value.trim().length > 0);
    if (values.length === 0) continue;

    /*
     * 颜色单独走一条 —— 它要带一块真色块回去。规范化仍旧只有
     * `normalizeHexColor` 那一处;这里只是把它接到「已确认」这条渲染路上,
     * 且**不改写**存下来的原文:规范不出来就照原样念,不装成一块颜色。
     */
    if (question.type === 'color') {
      for (const raw of values) {
        const canonical = normalizeHexColor(raw);
        items.push(
          canonical
            ? { label: question.label, value: canonical, swatch: canonical }
            : { label: question.label, value: raw },
        );
      }
      continue;
    }

    const catalog = visualStyleContext && questionUsesVisualStyleCatalog(question)
      ? visualStyleCardsForContext(visualStyleContext)
      : [];
    const normalized = catalog.length > 0 && visualStyleContext
      ? values.map((value) =>
          normalizeVisualStyleQuestionValue(question, value, visualStyleContext),
        )
      : values;
    const selectedCards = catalog.flatMap((card) =>
      normalized.includes(card.value) && card.preview
        ? [{ title: card.title, src: card.preview.src }]
        : [],
    );

    if (selectedCards.length > 0) {
      visualItems.push({ label: question.label, cards: selectedCards });
    }

    const readableWithoutPreview = normalized
      .filter((value) => !catalog.some((card) => card.value === value && card.preview))
      .map((value) => catalog.find((card) => card.value === value)?.title ?? readable(question, value));
    if (splitMultiValueItems) {
      for (const value of readableWithoutPreview) {
        items.push({ label: question.label, value });
      }
    } else if (readableWithoutPreview.length > 0) {
      items.push({ label: question.label, value: readableWithoutPreview.join(', ') });
    }
  }

  return { items, visualItems };
}
