// ============================================================
//  Point of Control (POC) Current Session Only
//  For Tradovate Custom Indicators
//
//  Draws a filled box at the highest-volume price level (POC)
//  for every candlestick in the active trading session only.
//  Bars from prior sessions receive no graphics, preventing
//  box accumulation across days.
//
//  Session boundary: configurable open hour (default 17:00),
//  matching the CME / Globex session (17:00 – 15:59 CT).
//  Times are evaluated in the browser's local timezone; set
//  sessionOpenHour to match your machine's local equivalent
//  of 17:00 CT if you are not in the Central timezone.
//
//  POC is the price level with the highest total traded volume
//  within the bar's volume profile.
//
//  REQUIRES: volumeProfiles = true (set in requirements below).
//  The chart must provide per-bar volume-profile data (i.e. a
//  Footprint or Volume Profile chart type in Tradovate).
//
//  NOTE: Must be used with the new "Chart" module, not Legacy Chart.
// ============================================================

const predef = require("./tools/predef");
const meta   = require("./tools/meta");
const { du } = require("./tools/graphics");

// ── Session helpers ───────────────────────────────────────────

/**
 * Returns the Date of the most-recent session open.
 * openHour is evaluated in LOCAL machine time (default 17 for CT).
 */
function currentSessionStart(openHour) {
    const now   = new Date();
    const start = new Date(now);
    start.setMinutes(0, 0, 0);

    if (now.getHours() < openHour) {
        // We are before the open hour — the session started yesterday.
        start.setDate(start.getDate() - 1);
    }

    start.setHours(openHour);
    return start;
}

// ── POC finder ────────────────────────────────────────────────

/**
 * Returns the price level with the highest total volume from the
 * bar's volume profile, or null when profile data is unavailable.
 *
 * VolumeProfileLevel fields: { price, vol, bidVol, askVol }
 * Uses bidVol + askVol as the primary metric (matches what footprint
 * charts display). Falls back to vol when bid/ask are absent.
 */
function findPOC(d) {
    let levels;
    try { levels = d.profile(); } catch (_) { return null; }

    if (!levels || levels.length === 0) return null;

    let maxVol   = 0;
    let pocPrice = null;

    for (const lvl of levels) {
        const bidAsk = (lvl.bidVol || 0) + (lvl.askVol || 0);
        const total  = bidAsk > 0 ? bidAsk : (lvl.vol || 0);

        if (total > maxVol) {
            maxVol   = total;
            pocPrice = lvl.price;
        }
    }

    return pocPrice;
}

// ── Calculator ────────────────────────────────────────────────

class PointOfControl {
    init() {
        // nothing to initialize
    }

    map(d) {
        // Skip bars that fall outside the current trading session.
        // currentSessionStart() uses the real wall clock so the threshold
        // advances automatically when the session open hour is crossed.
        const sessStart = currentSessionStart(this.props.sessionOpenHour);
        if (d.timestamp() < sessStart) return {};

        const pocPrice = findPOC(d);
        if (pocPrice === null) return {};

        const color     = this.props.pocColor;
        const lineWidth = this.props.lineWidth;
        const barIdx    = d.index();

        // A two-point "degenerate" polygon drawn only as a contour — this
        // renders as a horizontal line at the POC price using the same
        // ContourShapes primitive that the working box code uses.
        const points = [
            { x: du(barIdx - 0.5), y: du(pocPrice) },
            { x: du(barIdx + 0.5), y: du(pocPrice) },
        ];

        return {
            graphics: {
                items: [
                    {
                        tag: "ContourShapes",
                        key: `poc_line_${barIdx}`,
                        primitives: [{ tag: "Polygon", points }],
                        lineStyle: { color, lineWidth },
                    },
                ],
            },
        };
    }
}

// ── Module exports ────────────────────────────────────────────

module.exports = {
    name:        "PointOfControl",
    description: "POC",
    calculator:  PointOfControl,

    inputType:  meta.InputType.BARS,
    areaChoice: meta.AreaChoice.SAME,  // overlay on the main price chart

    // Enables d.profile() — required for per-bar volume-profile data.
    requirements: {
        volumeProfiles: true,
    },

    params: {
        pocColor:        predef.paramSpecs.color("#FFD700"),   // default: gold
        lineWidth:       predef.paramSpecs.number(1, 1, 1),    // line thickness (px)
        sessionOpenHour: predef.paramSpecs.number(17, 1, 0),   // local hour for session open
    },

    plots: {},

    tags: [predef.tags.Volumes],
};