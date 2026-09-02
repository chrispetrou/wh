import Link from "next/link";

export default function NotFound() {
  return (
    <div className="mx-auto max-w-[880px] px-6 pt-[88px]">
      <p>nothing here.</p>
      <p className="mt-7">
        <Link
          href="/"
          className="border-b border-border pb-0.5 font-semibold hover:border-foreground"
        >
          back home <span className="text-wh-green">→</span>
        </Link>
      </p>
    </div>
  );
}
