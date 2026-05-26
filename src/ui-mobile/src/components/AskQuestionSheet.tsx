import { useState } from "react";

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
  /**
   * Dismiss handler. The agent is mid-turn waiting for a control_response
   * — the caller is responsible for sending some response (typically a
   * deny with a "user dismissed" feedback string) so the CLI doesn't
   * block indefinitely. See ChatScreen.tsx for the wiring.
   */
  onDismiss: () => Promise<void> | void;
}

// Bottom sheet that surfaces an `AskUserQuestion` tool call from the
// agent stream. Mirrors the desktop's flow: the model gives one or more
// questions, each with a short list of suggested options; the user
// picks (or types an Other) and the answers get sent back as
// `submit_agent_answer` with the question text mapping to chosen option
// — the CLI keys answers by the question text in the input it receives,
// which we mirror in the wire payload.

// Keys answers by question INDEX, not by question text. Two questions
// with identical text (`"Which file?" / "Which file?"`) would collide
// on a text-keyed map, with the second answer overwriting the first and
// both option lists sharing selection state. Indexing avoids the
// collision; the submit handler re-projects the index → text mapping
// when building the wire payload.

export function AskQuestionSheet({ input, onSubmit, onDismiss }: Props) {
  const [answersByIndex, setAnswersByIndex] = useState<Record<number, string>>(
    {},
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const allAnswered = input.questions.every(
    (_, i) => (answersByIndex[i] ?? "").trim().length > 0,
  );

  const handleSubmit = async () => {
    setBusy(true);
    setError(null);
    try {
      // Re-key by question text for the wire payload (which is what
      // the CLI expects, per the desktop's `submit_agent_answer`).
      const wire: Record<string, string> = {};
      input.questions.forEach((q, i) => {
        wire[q.question] = answersByIndex[i] ?? "";
      });
      await onSubmit(wire);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const handleDismiss = () => {
    void onDismiss();
  };

  return (
    <div className="sheet-scrim" onClick={handleDismiss}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-header">
          <h2>The agent is asking</h2>
          <button className="ghost-btn" onClick={handleDismiss}>
            Cancel
          </button>
        </div>
        <div className="sheet-body">
          {input.questions.map((q, i) => (
            <div key={i} className="question-block">
              <p className="question-text">{q.question}</p>
              {q.options && q.options.length > 0 && (
                <div className="option-list">
                  {q.options.map((o, j) => (
                    <button
                      key={j}
                      className={`option ${
                        answersByIndex[i] === o.label ? "option-selected" : ""
                      }`}
                      onClick={() =>
                        setAnswersByIndex((prev) => ({
                          ...prev,
                          [i]: o.label,
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
                value={answersByIndex[i] ?? ""}
                onChange={(e) =>
                  setAnswersByIndex((prev) => ({
                    ...prev,
                    [i]: e.target.value,
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
