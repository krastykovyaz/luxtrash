// HTML email shell matching the app's visual identity — dark, hazard-tape
// accent, stamped bin badges. Built with inline styles and a table layout
// (no <style> block, no CSS variables, no flexbox) because that's what
// actually survives Gmail/Outlook/Apple Mail's CSS stripping, not because
// it's how the rest of the app is written.

const COLORS = {
  bg: "#15120C",
  surface: "#1E1911",
  ink: "#ECE4CE",
  inkSoft: "#B3A98C",
  inkFaint: "#85795D",
  accent: "#E7B62B",
  accentInk: "#1C1400",
  line: "#443A26"
};

const BIN_HEX = { M: "#9CA396", E: "#55A3CE", P: "#6E8FDB", V: "#6FB25F", B: "#D08A3E", R: "#E2604A" };

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// One stamped bin-code pill, e.g. for "Glass + Biowaste" → two badges.
function binBadge(code, label) {
  const hex = BIN_HEX[code] || COLORS.line;
  return (
    `<span style="display:inline-block;background-color:${hex};color:#1a1a1a;` +
    `font-family:Arial,Helvetica,sans-serif;font-weight:700;font-size:12px;` +
    `padding:6px 12px;border-radius:5px;margin:0 6px 6px 0;">${escapeHtml(label)}</span>`
  );
}

function binBadges(codes, labelFor) {
  return codes.split("").map((c) => binBadge(c, labelFor(c))).join("");
}

// bodyHtml is trusted content this module builds itself from template
// strings — never raw subscriber input — so it's inserted as-is; anything
// interpolated INTO bodyHtml by callers (names, Gemini output) must already
// be escapeHtml()'d by the caller before reaching here.
function wrapEmail(bodyHtml) {
  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background-color:${COLORS.bg};">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${COLORS.bg};">
      <tr>
        <td align="center" style="padding:32px 16px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background-color:${COLORS.surface};border-radius:12px;">
            <tr>
              <td style="padding:26px 28px 18px;">
                <div style="font-family:Arial,Helvetica,sans-serif;font-weight:800;font-size:24px;letter-spacing:1px;text-transform:uppercase;color:${COLORS.accent};">Bin Duty</div>
              </td>
            </tr>
            <tr>
              <td style="padding:0;">
                <div style="height:8px;line-height:8px;font-size:0;background-color:${COLORS.accent};">&nbsp;</div>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 28px 4px;font-family:Arial,Helvetica,sans-serif;color:${COLORS.ink};font-size:15px;line-height:1.5;">
                ${bodyHtml}
              </td>
            </tr>
            <tr>
              <td style="padding:22px 28px 26px;">
                <div style="border-top:1px solid ${COLORS.line};padding-top:14px;font-family:Arial,Helvetica,sans-serif;font-size:11px;color:${COLORS.inkFaint};">
                  Bin Duty &middot; <a href="https://binduty.sococoffee.com" style="color:${COLORS.inkFaint};">binduty.sococoffee.com</a>
                </div>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

module.exports = { wrapEmail, binBadge, binBadges, escapeHtml, COLORS, BIN_HEX };
