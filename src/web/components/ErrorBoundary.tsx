import { Component, type ReactNode } from "react";

/** Shows a readable message (and a way out) instead of a blank screen if a page fails to render. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    console.error("render error", error);
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div dir="rtl" className="mx-auto max-w-lg p-6 text-center">
        <h1 className="mb-2 text-xl font-bold">حدث خطأ في عرض الصفحة</h1>
        <p className="muted mb-4 text-sm">لم يُفقد شيء — البيانات محفوظة على الخادم. أرسل صورة من هذه الرسالة للمطوّر إن تكرر.</p>
        <pre className="surface-2 mb-4 overflow-auto rounded-lg p-3 text-left text-xs" dir="ltr">{String(this.state.error?.message ?? this.state.error).slice(0, 500)}</pre>
        <button
          className="btn btn-primary"
          onClick={() => {
            this.setState({ error: null });
            location.hash = "#/";
            location.reload();
          }}
        >
          العودة للرئيسية
        </button>
      </div>
    );
  }
}
