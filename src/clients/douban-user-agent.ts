/**
 * One UA for every Douban request.
 * 所有豆瓣请求共用的 UA。
 *
 * Douban's WAF judges both the RSS and subject-page clients by UA. Two copies of the same
 * default would eventually diverge; the historical variable name stays `DOUBAN_RSS_USER_AGENT`.
 * 豆瓣 WAF 同时按 UA 判断 RSS 与条目页客户端。两份相同默认值迟早会漂移；变量名沿用历史名称
 * `DOUBAN_RSS_USER_AGENT`。
 */
export const DOUBAN_USER_AGENT =
  process.env.DOUBAN_RSS_USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
