// Shared by the input guide and report routing/caveats.
(function(root){
  const guide = {
    matches(text){
      return /\b(?:colorectal|colon|rectal|rectum|sigmoid)\b/i.test(text || "") &&
        /\b(?:local\s+(?:resection|excision)|polypectomy|emr|esd|tem|tamis)\b/i.test(text || "");
    },
    notes: [
      "Haggitt (pedunculated pT1 tumours): 1 = head; 2 = neck; 3 = stalk; 4 = submucosa below the stalk, above muscularis propria.",
      "Kikuchi (sessile pT1 tumours): sm1 = upper third; sm2 = middle third; sm3 = lower third of the submucosa. Requires adequate submucosa and orientation; do not infer a level from depth in mm alone.",
      "Tumour budding: count in a 0.785 mm² H&E hotspot. Bd1 = 0–4 buds; Bd2 = 5–9 buds; Bd3 = 10 or more buds.",
      "Include the applicable level and bud count/grade in the input sentence. State Not applicable or Not assessable for Haggitt/Kikuchi where appropriate; no grade is assumed when omitted."
    ]
  };
  if (typeof module === "object" && module.exports) module.exports = guide;
  else root.ColorectalLocalGuide = guide;
})(typeof window !== "undefined" ? window : globalThis);
