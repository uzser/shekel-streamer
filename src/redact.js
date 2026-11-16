// Some scraper errors hold the request body, e.g. the Isracard login data with the password:
// "fetchPostWithinPage parse error: ..., url: ..., data: {...}, extraHeaders: {...}, result: ..."
// (upstream issue #1223). Remove everything from ", data: " before the text goes to a log.
export function redactScraperError(text) {
  return String(text || '').replace(/, data: [\s\S]*$/, ', data: <hidden>');
}
