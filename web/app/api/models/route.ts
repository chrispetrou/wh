// the models a provider offers, fetched with the key the user pasted so
// no shipped list has to be kept up to date. the browser cannot call a
// provider itself (connect-src 'self'), so this proxies; the key travels
// per request and is never stored or logged.
import { NextRequest, NextResponse } from "next/server";
import { detectProvider, modelIds, modelsUrl, providerFailure } from "@/lib/explain/providers";
import { sameOrigin } from "@/lib/origin";
import { getSession, touch } from "@/lib/session";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  if (!sameOrigin(req.headers.get("origin"), req.nextUrl.origin)) {
    return NextResponse.json({ error: "bad origin" }, { status: 403 });
  }
  const session = await getSession();
  if (!session.token) {
    return NextResponse.json({ error: "sign in required" }, { status: 401 });
  }
  await touch(session);

  const key = req.headers.get("x-wh-provider-key") ?? "";
  if (!key) {
    return NextResponse.json({ error: "paste an api key first" }, { status: 401 });
  }
  const provider = detectProvider(key);
  const url = modelsUrl(provider);

  let res: Response;
  try {
    res = await fetch(url, {
      headers:
        provider === "anthropic"
          ? { "x-api-key": key, "anthropic-version": "2023-06-01" }
          : { authorization: `Bearer ${key}` },
      cache: "no-store",
    });
  } catch {
    return NextResponse.json({ error: `could not reach ${new URL(url).host}` }, { status: 502 });
  }

  const body = await res.text();
  // a 404 here is a base url with no models endpoint, never an unknown
  // model (shared/prompts/provider.md)
  if (res.status === 404) {
    return NextResponse.json(
      { error: "provider has no models endpoint", hint: url },
      { status: 404 }
    );
  }
  if (!res.ok) {
    const f = providerFailure(res.status, body, "", { provider, headers: res.headers });
    // no model was asked about here, so never name a blank one
    const error = f.error.startsWith("provider has no model")
      ? "provider has no such endpoint"
      : f.error;
    return NextResponse.json({ error, hint: error === f.error ? f.hint : url }, { status: f.status });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return NextResponse.json({ error: "provider returned no models" }, { status: 502 });
  }
  const models = modelIds(parsed);
  if (models.length === 0) {
    return NextResponse.json({ error: "provider returned no models" }, { status: 502 });
  }
  return NextResponse.json({ provider, models }, { headers: { "cache-control": "no-store" } });
}
