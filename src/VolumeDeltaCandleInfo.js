// ============================================================
//  Delta Label Above Candle High
//  For Tradovate Custom Indicators
//
//  Plots bar delta value above each candle's high:
//    — Green for positive delta
//    — Red for negative delta
//    — Gray for zero delta
//
//  Delta = offerVolume - bidVolume (aggressor-based)
//  Uses d.bidVolume() and d.offerVolume()
//
//  NOTE: Must be used with the new "Chart" module, not Legacy Chart.
// ============================================================

const predef = require("./tools/predef");
const meta   = require("./tools/meta");
const { du, px, op } = require("./tools/graphics");

// ── Calculator ────────────────────────────────────────────────

class DeltaGrid {
    init() {
        // nothing to initialize
    }

    map(d) {
        const totalVol = d.volume();
        const barDelta = d.offerVolume() - d.bidVolume();

        const fSize  = this.props.fontSize;
        const offset = this.props.labelOffset;
        const rowGap = fSize + 4;

        const posC = this.props.positiveColor;
        const negC = this.props.negativeColor;
        const neuC = this.props.neutralColor;
        const lblC = this.props.labelColor;

        const dColor = barDelta > 0 ? posC : barDelta < 0 ? negC : neuC;

        const x      = du(d.index());
        const yDelta = op(du(d.high()), "-", px(offset));           // delta row (closer to high)
        const yVol   = op(du(d.high()), "-", px(offset + rowGap));  // volume row (above delta)

        return {
            graphics: {
                items: [
                    {
                        tag: "Container",
                        key: `grid_${d.index()}`,
                        children: [
                            // Volume row
                            {
                                tag:           "Text",
                                key:           `vol_${d.index()}`,
                                point:         { x, y: yVol },
                                text:          `V: ${Math.round(totalVol)}`,
                                style:         { fontSize: fSize, fontWeight: "normal", fill: lblC },
                                textAlignment: "centerMiddle",
                            },
                            // Delta row
                            {
                                tag:           "Text",
                                key:           `delta_${d.index()}`,
                                point:         { x, y: yDelta },
                                text:          `D: ${Math.round(barDelta)}`,
                                style:         { fontSize: fSize, fontWeight: "bold", fill: dColor },
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
    name:        "VolumeDeltaCandleInfo",
    description: "Volume Delta Candle Info",
    calculator:  DeltaGrid,

    inputType:  meta.InputType.BARS,
    areaChoice: meta.AreaChoice.SAME,   // overlay on main price chart

    params: {
        positiveColor: predef.paramSpecs.color("#55cc55"),
        negativeColor: predef.paramSpecs.color("#dd5555"),
        neutralColor:  predef.paramSpecs.color("#888888"),
        labelColor:    predef.paramSpecs.color("#aaaaaa"),
        fontSize:      predef.paramSpecs.number(10, 1, 8),
        labelOffset:   predef.paramSpecs.number(8, 1, 2),  // px above the high wick
    },

    plots: {},

    tags: [predef.tags.Volumes],
};