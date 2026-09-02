import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // the repo keeps its own curated CLAUDE.md; skip the generated agent docs
  agentRules: false,
  // auto-memoize components: the terminal re-renders on every keystroke
  reactCompiler: true,
  // self-contained server bundle for the docker image (web/Dockerfile);
  // local dev and next start are unaffected
  output: "standalone",
  experimental: {
    // the react taint api guards the github token (see lib/session.ts)
    taint: true,
  },
};

export default nextConfig;
