// ============================================================
//  Volume / Delta / Cumulative Delta Grid
//  For Tradovate Custom Indicators
//
//  Compact separate panel with three text rows per bar:
//    Row 1 — Total Volume        (neutral color)
//    Row 2 — Bar Delta           (green / red / gray)
//    Row 3 — Cumulative Delta    (green / red / gray, resets daily)
//
//  Delta = offerVolume - bidVolume (aggressor-based)
//  Uses d.bidVolume() and d.offerVolume() — no histogram required.
//
//  NOTE: Must be used with the new "Chart" module, not Legacy Chart.
// ============================================================

const predef = require("./tools/predef");
const meta   = require("./tools/meta");
const { du, px, op } = require("./tools/graphics");

// ── Helpers ───────────────────────────────────────────────────

function dayKey(date) {
    return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

// ── Calculator ────────────────────────────────────────────────

class DeltaGrid {
    init() {
        this.cumDelta = 0;
        this.lastDay  = null;
    }

    map(d) {
        const date = d.timestamp();
        const dKey = dayKey(date);

        if (this.lastDay !== dKey) {
            this.cumDelta = 0;
            this.lastDay  = dKey;
        }

        const totalVol = d.volume();
        const barDelta = d.offerVolume() - d.bidVolume();
        this.cumDelta += barDelta;

        const fSize  = this.props.fontSize;
        const rowGap = fSize + 4;

        const posC = this.props.positiveColor;
        const negC = this.props.negativeColor;
        const neuC = this.props.neutralColor;
        const lblC = this.props.labelColor;

        const dColor  = barDelta      > 0 ? posC : barDelta      < 0 ? negC : neuC;
        const cdColor = this.cumDelta > 0 ? posC : this.cumDelta < 0 ? negC : neuC;

        const x    = du(d.index());
        const yMid = du(0);

        return {
            lower: -1,
            upper:  1,

            graphics: {
                items: [
                    {
                        tag:      "Container",
                        key:      `grid_${d.index()}`,
                        children: [
                            // Row 1 — Volume (top)
                            {
                                tag:           "Text",
                                key:           `vol_${d.index()}`,
                                point: {
                                    x,
                                    y: op(yMid, "-", px(rowGap)),
                                },
                                text:          String(Math.round(totalVol)),
                                style:         { fontSize: fSize, fontWeight: "normal", fill: lblC },
                                textAlignment: "centerMiddle",
                            },
                            // Row 2 — Bar Delta (middle)
                            {
                                tag:           "Text",
                                key:           `delta_${d.index()}`,
                                point: {
                                    x,
                                    y: yMid,
                                },
                                text:          String(Math.round(barDelta)),
                                style:         { fontSize: fSize, fontWeight: "normal", fill: dColor },
                                textAlignment: "centerMiddle",
                            },
                            // Row 3 — Cumulative Delta (bottom)
                            {
                                tag:           "Text",
                                key:           `cdelta_${d.index()}`,
                                point: {
                                    x,
                                    y: op(yMid, "+", px(rowGap)),
                                },
                                text:          String(Math.round(this.cumDelta)),
                                style:         { fontSize: fSize, fontWeight: "normal", fill: cdColor },
                                textAlignment: "centerMiddle",
                            },
                        ],
                    },
                ],
            },
        };
    }
}

// ── Module exports ────────────────────────────────────────────

module.exports = {
    name:        "DeltaGrid",
    description: "Volume / Delta / Cumulative Delta Grid",
    calculator:  DeltaGrid,

    inputType:  meta.InputType.BARS,
    areaChoice: meta.AreaChoice.NEW,

    params: {
        positiveColor: predef.paramSpecs.color("#55cc55"),
        negativeColor: predef.paramSpecs.color("#dd5555"),
        neutralColor:  predef.paramSpecs.color("#888888"),
        labelColor:    predef.paramSpecs.color("#aaaaaa"),
        fontSize:      predef.paramSpecs.number(10, 1, 8),
    },

    plots: {
        lower: { title: "Lower", visible: false },
        upper: { title: "Upper", visible: false },
    },

    scaler: predef.scalers.multiPath(["lower", "upper"]),

    plotter: [
        predef.plotters.singleline("lower"),
    ],

    tags: [predef.tags.Volumes],

    schemeStyles: {
        dark: {
            lower: { color: "transparent" },
            upper: { color: "transparent" },
        },
    },
};