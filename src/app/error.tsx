"use client";

export default function ErrorPage({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="card empty" role="alert">
      <h2>Something went wrong</h2>
      <p className="muted">The page couldn&apos;t be shown. Your data is safe and nothing was changed. Try again, and if it keeps failing, check Pipeline Health.</p>
      <button type="button" className="btn" onClick={reset}>Try again</button>
    </div>
  );
}
