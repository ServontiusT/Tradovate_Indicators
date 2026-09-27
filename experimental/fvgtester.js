// FVG Order Flow Tester for Tradovate
// ------------------------------------------------------------
// 1. Auto-detects 3-candle Fair Value Gaps and draws a box for each.
// 2. Profiles the displacement (middle) candle from bid/ask volume,
//    back-to-back at the candle's center:
//      - Delta profile grows LEFT
//      - Volume profile grows RIGHT
// 3. Marks the first stacked-imbalance price in the direction of the move.
//
// Install: Code Explorer -> File -> New, paste, save, add to chart.
// Needs bid/ask volume data (the same data that powers footprint charts).
// ------------------------------------------------------------

const predef = require("./tools/predef");
const { px, du, op } = require("./tools/graphics");

class FVGOrderFlowTester {
    init() {
        this.bars = [];
        this.lastBuilt = -1;
        this.cached = {};
    }

    map(d, i) {
        const prof = typeof d.profile === "function" ? (d.profile() || []) : [];
        // x position on the chart must come from d.index(), not the map() counter
        const x = typeof d.index === "function" ? d.index() : i;
        // Overwrite (not accumulate) so live tick updates don't double count
        this.bars[i] = { h: d.high(), l: d.low(), x, prof };

        if (!d.isLast()) return {};
        if (this.props.debug && this.lastBuilt < 0) {
            console.log(`[FVGOF] bars=${i + 1} firstIndex=${this.bars[0] && this.bars[0].x} lastIndex=${x} ` +
                        `profileRows(last bar)=${prof.length} tick=${this.contractInfo.tickSize}`);
        }
        // Only rebuild when a new bar opens (the previous bar is then final)
        if (i === this.lastBuilt) return this.cached;
        this.lastBuilt = i;
        this.cached = this.build(i);
        return this.cached;
    }

    // ---------------- main pipeline ----------------
    build(last) {
        const p = this.props;
        const tick = this.contractInfo.tickSize;
        const T = v => Math.round(v / tick); // price -> tick units

        const tb = this.bars.map(b => b ? { h: T(b.h), l: T(b.l), x: b.x, prof: b.prof } : null);

        const fvgs = [];
        // 3rd candle must be closed, so k <= last - 1
        for (let k = 2; k <= last - 1; k++) {
            const a = tb[k - 2], m = tb[k - 1], c = tb[k];
            if (!a || !m || !c) continue;

            let dir = 0, top, bottom;
            if (p.detectBullish && c.l > a.h) { dir = 1; bottom = a.h; top = c.l; }
            else if (p.detectBearish && c.h < a.l) { dir = -1; top = a.l; bottom = c.h; }
            if (!dir || top - bottom < p.minGapTicks) continue;

            const f = { id: k, dir, top, bottom, startIdx: k - 2, dispIdx: k - 1, thirdIdx: k };
            this.analyzeCandle(f, m.prof, tick);
            this.extend(f, tb, last);
            fvgs.push(f);
        }

        if (p.debug) {
            const withProf = fvgs.filter(f => f.rows.length).length;
            const withStack = fvgs.filter(f => f.stack != null).length;
            console.log(`[FVGOF] FVGs=${fvgs.length} withProfileData=${withProf} withStack=${withStack}`);
        }
        return { graphics: { items: this.draw(fvgs, tb, last, tick) } };
    }

    // ---------------- displacement candle order flow ----------------
    analyzeCandle(f, prof, tick) {
        const p = this.props;
        const rows = new Map();
        prof.forEach(r => {
            const k = Math.round(r.price / tick);
            const row = rows.get(k) || { k, vol: 0, bid: 0, ask: 0 };
            row.vol += r.vol || 0;
            row.bid += r.bidVol || 0;
            row.ask += r.askVol || 0;
            rows.set(k, row);
        });
        const list = [...rows.values()].sort((a, b) => a.k - b.k);
        list.forEach(r => { r.delta = r.ask - r.bid; }); // + = aggressive buying
        f.rows = list;
        f.stack = null;
        if (!list.length) return;

        // Diagonal imbalances: buy = ask[p] vs bid[p-1], sell = bid[p] vs ask[p+1]
        const get = k => rows.get(k) || { bid: 0, ask: 0 };
        const isImb = r => {
            if (f.dir === 1) {
                const opp = get(r.k - 1).bid;
                return r.ask >= p.minImbalanceVol && r.ask >= p.imbalanceRatio * opp;
            }
            const opp = get(r.k + 1).ask;
            return r.bid >= p.minImbalanceVol && r.bid >= p.imbalanceRatio * opp;
        };

        // First stack in the direction of the move: lowest for bullish, highest for bearish
        const seq = f.dir === 1 ? list : [...list].reverse();
        let run = 0, runStart = null, prevK = null;
        for (const r of seq) {
            const contiguous = prevK !== null && Math.abs(r.k - prevK) === 1;
            if (isImb(r)) {
                if (run > 0 && contiguous) run++;
                else { run = 1; runStart = r.k; }
                if (run >= p.stackCount) { f.stack = runStart; break; }
            } else run = 0;
            prevK = r.k;
        }
    }

    // ---------------- how far to extend the box and stack line ----------------
    extend(f, tb, last) {
        const p = this.props;
        const maxEnd = Math.min(last, f.thirdIdx + p.maxExtendBars);
        f.boxEnd = maxEnd;
        f.stackEnd = maxEnd;
        f.filled = false;
        let stackDone = f.stack == null;

        for (let j = f.thirdIdx + 1; j <= maxEnd; j++) {
            const b = tb[j];
            if (!b) continue;
            if (!stackDone && (f.dir === 1 ? b.l <= f.stack : b.h >= f.stack)) {
                f.stackEnd = j; stackDone = true;
            }
            // Gap fully filled: traded through the far side
            if (f.dir === 1 ? b.l <= f.bottom : b.h >= f.top) {
                f.boxEnd = j; f.filled = true;
                if (!stackDone) f.stackEnd = j;
                break;
            }
        }
    }

    // ---------------- drawing ----------------
    draw(fvgs, tb, last, tick) {
        const p = this.props;
        const children = [];
        const y = k => du(k * tick);
        // array position -> chart x (extrapolates past the last bar)
        const lastX = tb[last].x;
        const X = j => du(j <= last && tb[j] ? tb[j].x : lastX + (j - last));

        const shown = fvgs.slice(Math.max(0, fvgs.length - p.maxDrawn));
        shown.forEach(f => {
            const id = "fvg" + f.id;
            const boxColor = f.filled ? p.filledColor : (f.dir === 1 ? p.bullBoxColor : p.bearBoxColor);

            // FVG box outline
            children.push({
                tag: "LineSegments", key: id + "_box",
                lines: [
                    { tag: "Line", a: { x: X(f.startIdx), y: y(f.top) },    b: { x: X(f.boxEnd), y: y(f.top) } },
                    { tag: "Line", a: { x: X(f.startIdx), y: y(f.bottom) }, b: { x: X(f.boxEnd), y: y(f.bottom) } },
                    { tag: "Line", a: { x: X(f.startIdx), y: y(f.bottom) }, b: { x: X(f.startIdx), y: y(f.top) } },
                    { tag: "Line", a: { x: X(f.boxEnd), y: y(f.bottom) },   b: { x: X(f.boxEnd), y: y(f.top) } }
                ],
                lineStyle: { lineWidth: 1, color: boxColor }
            });

            // Stacked imbalance line: from the displacement candle to first touch
            if (p.showStackLine && f.stack != null) {
                children.push({
                    tag: "LineSegments", key: id + "_stack",
                    lines: [{ tag: "Line",
                        a: { x: X(f.dispIdx), y: y(f.stack) },
                        b: { x: X(Math.max(f.stackEnd, f.thirdIdx + 1)), y: y(f.stack) } }],
                    lineStyle: { lineWidth: 2, color: p.stackColor }
                });
            }

            // Back-to-back profiles at the displacement candle's center
            if (p.showProfiles && f.rows.length) {
                const maxVol = Math.max(...f.rows.map(r => r.vol)) || 1;
                const maxAbsD = Math.max(...f.rows.map(r => Math.abs(r.delta))) || 1;
                const rowH = op(du(tick), "-", px(1));
                const half = p.centerGapPx / 2;
                const center = X(f.dispIdx);
                const volX = op(center, "+", px(half));
                const dX = op(center, "-", px(half));

                f.rows.forEach(r => {
                    const yBot = du((r.k - 0.5) * tick);
                    children.push({
                        tag: "Shapes", key: `${id}_v${r.k}`,
                        primitives: [{ tag: "Rectangle", position: { x: volX, y: yBot },
                            size: { width: px(Math.max(1, p.profileWidthPx * r.vol / maxVol)), height: rowH } }],
                        fillStyle: { color: p.volumeColor }
                    });
                    children.push({
                        tag: "Shapes", key: `${id}_d${r.k}`,
                        primitives: [{ tag: "Rectangle", position: { x: dX, y: yBot },
                            size: { width: px(-Math.max(1, p.profileWidthPx * Math.abs(r.delta) / maxAbsD)), height: rowH } }],
                        fillStyle: { color: r.delta >= 0 ? p.positiveColor : p.negativeColor }
                    });
                });
            }
        });

        // One global container in chart (data) coordinates
        return [{ tag: "Container", key: "fvgof_main", global: true, children }];
    }
}

module.exports = {
    name: "FVGOrderFlowTester",
    description: "FVG Order Flow Tester",
    calculator: FVGOrderFlowTester,
    inputType: "bars",
    params: {
        // Detection
        detectBullish: predef.paramSpecs.bool(true),
        detectBearish: predef.paramSpecs.bool(true),
        minGapTicks: predef.paramSpecs.number(2, 1, 1),
        maxExtendBars: predef.paramSpecs.number(200, 10, 10),
        // Stacked imbalances
        imbalanceRatio: predef.paramSpecs.number(3, 0.5, 1),
        minImbalanceVol: predef.paramSpecs.number(5, 1, 0),
        stackCount: predef.paramSpecs.number(3, 1, 2),
        // Display
        maxDrawn: predef.paramSpecs.number(20, 1, 0),
        showProfiles: predef.paramSpecs.bool(true),
        showStackLine: predef.paramSpecs.bool(true),
        profileWidthPx: predef.paramSpecs.number(60, 5, 5),
        centerGapPx: predef.paramSpecs.number(2, 1, 0),
        debug: predef.paramSpecs.bool(false),
        // Colors
        bullBoxColor: predef.paramSpecs.color("#26a69a"),
        bearBoxColor: predef.paramSpecs.color("#ef5350"),
        filledColor: predef.paramSpecs.color("#666666"),
        stackColor: predef.paramSpecs.color("#ff7043"),
        volumeColor: predef.paramSpecs.color("#5c6b80"),
        positiveColor: predef.paramSpecs.color("#26a69a"),
        negativeColor: predef.paramSpecs.color("#ef5350")
    },
    tags: [predef.tags.Volumes],
    schemeStyles: predef.styles.solidLine("#000"),
    requirements: { volumeProfiles: true }
};