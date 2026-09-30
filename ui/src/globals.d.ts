// marked and DOMPurify load at runtime from /marked.min.js and /dompurify.min.js
// (`external` in vite.config.ts), so TypeScript needs ambient declarations.
// Wildcards: a leading-slash specifier does not match an exact `declare module`.
declare module '*marked.min.js' {
  export const marked: {
    setOptions(o: Record<string, unknown>): void;
    parse(md: string): string;
  };
}

declare module '*dompurify.min.js' {
  const DOMPurify: { sanitize(html: string, cfg?: Record<string, unknown>): string };
  export default DOMPurify;
}
