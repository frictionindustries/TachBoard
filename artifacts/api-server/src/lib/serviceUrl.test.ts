import { describe, expect, it } from "vitest";
import { validateServiceBaseUrl, InvalidServiceBaseUrlError } from "./serviceUrl.js";

describe("service base URLs", () => {
  it.each([
    "http://10.0.0.8/actuator/env?",
    "http://10.0.0.8/actuator/env?x=1",
    "http://10.0.0.8/#",
    "http://10.0.0.8/#ignored",
    "http://user:secret@10.0.0.8/proxy",
    "http://@10.0.0.8/proxy",
    "ftp://10.0.0.8", "file:///etc/passwd", "javascript:alert(1)",
    "http:10.0.0.8", "https:/10.0.0.8", "//10.0.0.8",
    "http://10.0.0.8\\proxy", "http://10.0.0.8/\nproxy",
    "http://10.0.0.8/\tproxy", "http://10.0.0.8/\u0000proxy",
    "http://", "http:///10.0.0.8", "http://10.0.0.8:99999", "",
    "http://10.0.0.8/%3f", "http://10.0.0.8/%23",
    "http://10.0.0.8/%253f", "http://10.0.0.8/%2523",
    "http://10.0.0.8/%2f", "http://10.0.0.8/%5c",
    "http://10.0.0.8/%0a", "http://10.0.0.8/%C2%85",
    "http://10.0.0.8/proxy/../actuator/env",
    "http://10.0.0.8/proxy/%2e%2e/actuator/env",
    "http://10.0.0.8/proxy/%252e%252e/actuator/env",
    "http://10.0.0.8/%zz",
  ])("rejects unsafe or malformed base %s", (url) => {
    expect(() => validateServiceBaseUrl(url)).toThrow(InvalidServiceBaseUrlError);
  });

  it.each([
    ["http://10.0.0.8/proxy/truenas/", "http://10.0.0.8/proxy/truenas"],
    ["10.0.0.8:8080/proxy/", "http://10.0.0.8:8080/proxy"],
    ["https://nas.local/services/v1.2/", "https://nas.local/services/v1.2"],
    ["http://[::1]:8080/proxy", "http://[::1]:8080/proxy"],
    [" https://nas.local/my%20proxy/caf%C3%A9/ ", "https://nas.local/my%20proxy/caf%C3%A9"],
  ])("preserves safe proxy prefixes: %s", (url, expected) => {
    expect(validateServiceBaseUrl(url)).toBe(expected);
  });
});