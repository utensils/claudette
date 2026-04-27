import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { AgentQuestion } from "../../stores/useAppStore";
import styles from "./AgentQuestionCard.module.css";

interface AgentQuestionCardProps {
  question: AgentQuestion;
  /**
   * Called with answers keyed by question text — matches the CLI's
   * `mapToolResultToToolResultBlockParam` input shape. Multi-select answers
   * are comma-separated into a single string per question.
   */
  onRespond: (answers: Record<string, string>) => void;
}

export function AgentQuestionCard({
  question,
  onRespond,
}: AgentQuestionCardProps) {
  const { t } = useTranslation("chat");
  const total = question.questions.length;
  const isSingleQuestion = total === 1;

  // All hooks declared unconditionally (React rules of hooks)
  const [selections, setSelections] = useState<Record<number, Set<number>>>(
    () => Object.fromEntries(question.questions.map((_, i) => [i, new Set()]))
  );
  const [freeform, setFreeform] = useState("");
  const [currentIndex, setCurrentIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [freeformTexts, setFreeformTexts] = useState<Record<number, string>>(
    {}
  );

  // ── Single question: original behavior unchanged ──
  if (isSingleQuestion) {
    const q = question.questions[0];
    const isMulti = q.multiSelect ?? false;
    const currentSelections = selections[0] ?? new Set<number>();

    const respondSingle = (answer: string) => {
      onRespond({ [q.question]: answer });
    };

    const toggleSingle = (optIdx: number) => {
      if (!isMulti) {
        const opt = q.options[optIdx];
        if (opt) respondSingle(opt.label);
        return;
      }
      setSelections((prev) => {
        const current = prev[0] ?? new Set();
        const next = new Set(current);
        if (next.has(optIdx)) next.delete(optIdx);
        else next.add(optIdx);
        return { ...prev, 0: next };
      });
    };

    const hasSelections = currentSelections.size > 0;

    return (
      <div className={styles.card}>
        <div className={styles.label}>{t("agent_question_title")}</div>
        <div className={styles.questionBlock}>
          {q.header && <div className={styles.header}>{q.header}</div>}
          <div className={styles.question}>{q.question}</div>
          {q.options.length > 0 && (
            <div className={styles.options}>
              {q.options.map((opt, optIdx) => {
                const isSelected = currentSelections.has(optIdx);
                return (
                  <button
                    key={optIdx}
                    className={`${styles.option} ${isSelected ? styles.optionSelected : ""}`}
                    onClick={() => toggleSingle(optIdx)}
                  >
                    <span className={styles.optionLabel}>{opt.label}</span>
                    {opt.description && (
                      <span className={styles.optionDesc}>
                        {opt.description}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
        {isMulti && hasSelections && (
          <button
            className={styles.confirmBtn}
            onClick={() => {
              const chosen = [...currentSelections]
                .map((idx) => q.options[idx]?.label)
                .filter(Boolean);
              if (chosen.length > 0) respondSingle(chosen.join(", "));
            }}
          >
            {t("agent_question_submit_answer")}
          </button>
        )}
        <div className={styles.divider}>{t("agent_question_or_type")}</div>
        <div className={styles.freeformRow}>
          <textarea
            className={styles.freeformInput}
            value={freeform}
            onChange={(e) => setFreeform(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                const text = freeform.trim();
                if (text) respondSingle(text);
              }
            }}
            placeholder={t("agent_question_placeholder")}
            rows={1}
          />
          <button
            className={styles.submitBtn}
            onClick={() => {
              const text = freeform.trim();
              if (text) respondSingle(text);
            }}
            disabled={!freeform.trim()}
          >
            {t("agent_question_send")}
          </button>
        </div>
      </div>
    );
  }

  // ── Multi-question wizard ──
  const q = question.questions[currentIndex];
  const isLast = currentIndex === total - 1;
  const isFirst = currentIndex === 0;
  const currentFreeform = freeformTexts[currentIndex] ?? "";
  const currentSelections = selections[currentIndex] ?? new Set<number>();
  const isMultiSelect = q.multiSelect ?? false;

  const getCurrentAnswer = (): string | null => {
    const text = currentFreeform.trim();
    if (text) return text;
    if (currentSelections.size > 0) {
      return [...currentSelections]
        .map((idx) => q.options[idx]?.label)
        .filter(Boolean)
        .join(", ");
    }
    return null;
  };

  const submitAll = (finalAnswers: Record<number, string>) => {
    const payload: Record<string, string> = {};
    for (let i = 0; i < total; i++) {
      const qItem = question.questions[i];
      const answer = finalAnswers[i];
      if (answer) {
        payload[qItem.question] = answer;
      }
    }
    if (Object.keys(payload).length > 0) {
      onRespond(payload);
    }
  };

  const handleOptionClick = (optIdx: number) => {
    // Clear freeform when selecting an option
    setFreeformTexts((prev) => ({ ...prev, [currentIndex]: "" }));

    if (!isMultiSelect) {
      // Single-select: set selection, save answer, auto-advance
      const opt = q.options[optIdx];
      if (!opt) return;
      setSelections((prev) => ({
        ...prev,
        [currentIndex]: new Set([optIdx]),
      }));
      const newAnswers = { ...answers, [currentIndex]: opt.label };
      setAnswers(newAnswers);
      if (isLast) {
        submitAll(newAnswers);
      } else {
        setCurrentIndex((i) => i + 1);
      }
      return;
    }

    // Multi-select: toggle
    setSelections((prev) => {
      const current = prev[currentIndex] ?? new Set();
      const next = new Set(current);
      if (next.has(optIdx)) next.delete(optIdx);
      else next.add(optIdx);
      return { ...prev, [currentIndex]: next };
    });
  };

  const handleNext = () => {
    const answer = getCurrentAnswer();
    if (!answer) return;
    const newAnswers = { ...answers, [currentIndex]: answer };
    setAnswers(newAnswers);
    if (isLast) {
      submitAll(newAnswers);
    } else {
      setCurrentIndex((i) => i + 1);
    }
  };

  const handleBack = () => {
    if (isFirst) return;
    // Save current answer before going back
    const answer = getCurrentAnswer();
    if (answer) {
      setAnswers((prev) => ({ ...prev, [currentIndex]: answer }));
    }
    setCurrentIndex((i) => i - 1);
  };

  const handleFreeformChange = (text: string) => {
    setFreeformTexts((prev) => ({ ...prev, [currentIndex]: text }));
    // Clear option selections when typing freeform
    if (text) {
      setSelections((prev) => ({ ...prev, [currentIndex]: new Set() }));
    }
  };

  const canAdvance = getCurrentAnswer() !== null;

  return (
    <div className={styles.card}>
      <div className={styles.label}>{t("agent_question_title")}</div>

      <div className={styles.progressBar}>
        <span className={styles.progressText}>
          {t("agent_question_progress", { current: currentIndex + 1, total })}
        </span>
        <div className={styles.progressTrack}>
          <div
            className={styles.progressFill}
            style={{ width: `${((currentIndex + 1) / total) * 100}%` }}
          />
        </div>
      </div>

      <div key={currentIndex} className={styles.questionBlock}>
        {q.header && <div className={styles.header}>{q.header}</div>}
        <div className={styles.question}>{q.question}</div>
        {q.options.length > 0 && (
          <div className={styles.options}>
            {q.options.map((opt, optIdx) => {
              const isSelected = currentSelections.has(optIdx);
              return (
                <button
                  key={optIdx}
                  className={`${styles.option} ${isSelected ? styles.optionSelected : ""}`}
                  onClick={() => handleOptionClick(optIdx)}
                >
                  <span className={styles.optionLabel}>{opt.label}</span>
                  {opt.description && (
                    <span className={styles.optionDesc}>
                      {opt.description}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className={styles.divider}>{t("agent_question_or_type")}</div>

      <div className={styles.freeformRow}>
        <textarea
          className={styles.freeformInput}
          value={currentFreeform}
          onChange={(e) => handleFreeformChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleNext();
            }
          }}
          placeholder={t("agent_question_placeholder")}
          rows={1}
        />
      </div>

      <div className={styles.navRow}>
        <button
          className={`${styles.navBtn} ${styles.backBtn}`}
          onClick={handleBack}
          disabled={isFirst}
        >
          {t("agent_question_back")}
        </button>
        <button
          className={styles.navBtn}
          onClick={handleNext}
          disabled={!canAdvance}
        >
          {isLast ? t("agent_question_submit") : t("agent_question_next")}
        </button>
      </div>
    </div>
  );
}
