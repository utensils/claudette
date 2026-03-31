import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("React error boundary caught:", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            padding: 24,
            color: "#e6e6eb",
            background: "#121216",
            height: "100%",
            fontFamily: "monospace",
            fontSize: 13,
          }}
        >
          <h2 style={{ color: "#cc3333", marginBottom: 12 }}>
            Something went wrong
          </h2>
          <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
            {this.state.error.message}
          </pre>
          <pre
            style={{
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              color: "#808089",
              marginTop: 12,
              fontSize: 11,
            }}
          >
            {this.state.error.stack}
          </pre>
          <button
            onClick={() => this.setState({ error: null })}
            style={{
              marginTop: 16,
              padding: "6px 16px",
              background: "rgba(255,255,255,0.1)",
              border: "1px solid #333",
              color: "#e6e6eb",
              borderRadius: 4,
              cursor: "pointer",
            }}
          >
            {/* Only useful for transient render errors. If the error is caused
                by corrupted store state, the same crash will recur immediately. */}
            Try Again
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
