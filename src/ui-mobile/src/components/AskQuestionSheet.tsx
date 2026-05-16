import { useMemo, useState } from "react";

interface QuestionOption {
  label: string;
}

interface Question {
  question: string;
  options?: QuestionOption[];
  /** When true, the user may pick more than one option. */
  multiSelect?: boolean;
}

export interface AskQuestionInput {
  questions: Question[];
}

interface Props {
  toolUseId: string;
  input: AskQuestionInput;
  onSubmit: (answers: Record<string, string>) => Promise<void>;
  onClose: () => void;
}

// Bottom sheet that surfaces an `AskUserQuestion` tool call from the
// agent stream. Mirrors the desktop's flow: the model gives one or more
// questions, each with a short list of suggested options; the user
// picks (or types an Other) and the answers get sent back as
// `submit_agent_answer` with the question-text → chosen-option mapping
// the CLI expects.

export function AskQuestionSheet({ input, onSubmit, onClose }: Props) {
  const initial = useMemo(() => {
    const map: Record<string, string> = {};
    for (const q of input.questions) {
      map[q.question] = "";
    }
    return map;
  }, [input]);

  const [answers, setAnswers] = useState<Record<string, string>>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const allAnswered = input.questions.every(
    (q) => (answers[q.question] ?? "").trim().length > 0,
  );

  const handleSubmit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onSubmit(answers);
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sheet-scrim" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-header">
          <h2>The agent is asking</h2>
          <button className="ghost-btn" onClick={onClose}>
            Cancel
          </button>
        </div>
        <div className="sheet-body">
          {input.questions.map((q) => (
            <div key={q.question} className="question-block">
              <p className="question-text">{q.question}</p>
              {q.options && q.options.length > 0 && (
                <div className="option-list">
                  {q.options.map((o) => (
                    <button
                      key={o.label}
                      className={`option ${
                        answers[q.question] === o.label ? "option-selected" : ""
                      }`}
                      onClick={() =>
                        setAnswers((prev) => ({
                          ...prev,
                          [q.question]: o.label,
                        }))
                      }
                    >
                      {o.label}
                    </button>
                  ))}
                </div>
              )}
              <input
                className="paste-input"
                placeholder="Or type your own answer…"
                value={answers[q.question] ?? ""}
                onChange={(e) =>
                  setAnswers((prev) => ({
                    ...prev,
                    [q.question]: e.target.value,
                  }))
                }
              />
            </div>
          ))}
          {error && <div className="error">{error}</div>}
        </div>
        <div className="sheet-footer">
          <button
            className="primary"
            onClick={() => void handleSubmit()}
            disabled={busy || !allAnswered}
          >
            {busy ? "Sending…" : "Submit"}
          </button>
        </div>
      </div>
    </div>
  );
}
