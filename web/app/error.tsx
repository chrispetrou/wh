"use client";

export default function Error({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="mx-auto max-w-[880px] px-6 pt-[88px]">
      <p>something broke.</p>
      <p className="mt-4 text-muted-foreground">
        the error was logged to the server console.
      </p>
      <p className="mt-7">
        <button
          type="button"
          onClick={reset}
          className="cursor-pointer border-b border-border pb-0.5 font-semibold hover:border-foreground"
        >
          try again <span className="text-wh-green">→</span>
        </button>
      </p>
    </div>
  );
}
