import { describe, expect, it } from "vitest";
import { INSTALL_SITE, installLink } from "../src/install-link.js";

describe("installLink", () => {
  it("puts the encoded relay url and the code in the fragment of the install page", () => {
    expect(INSTALL_SITE).toBe("https://t3-cardputer.jopcmelo.com");
    expect(installLink("https://relay.example.com:8443", "K7Q2AB9X")).toBe("https://t3-cardputer.jopcmelo.com/install#r=https%3A%2F%2Frelay.example.com%3A8443&c=K7Q2AB9X");
  });
});
