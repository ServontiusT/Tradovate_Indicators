// ProfileLevels: volume and delta profiles of a previous session, week or month
// pinned to the left edge of the chart, and of the current session pinned to
// the right edge.
// Port of the MotiveWave ProfileLevels study (ProfileModule + ProfileSnapshot +
// PriceHistogram + SegmentCache + SessionClock).
//
// Differences from MotiveWave:
//  - Profiles are built from each bar's volume at price (d.profile()), with
//    delta = askVol - bidVol. There is no tick stream, so the Delta Method
//    choice is gone. A bar with no profile spreads its volume evenly across
//    its range and adds no delta, like MotiveWave without tick history.
//  - A bar's volume goes to the session its bar opens in, so use an intraday
//    chart (bars that do not straddle 08:30 or 17:00 CT).
//  - Colors are fixed (no color param in Tradovate).
//  - The profile is always 250 px wide (the canvas width cannot be read).
//  - The summary label prints "VAH | POC | VAL" in one color.
const predef = require("./tools/predef");
const meta = require("./tools/meta");
const { px, du, op } = require("./tools/graphics");

// ── SessionClock: America/Chicago, US DST rule hard-coded ──────────────
const MIN = 60e3, DAY = 86400e3;
const RTH_OPEN = 8 * 60 + 30, GLOBEX_OPEN = 17 * 60;   // CT minutes of day
const SUN = 0, SAT = 6;

function nthSundayUtc(y, month, n) {
    const first = new Date(Date.UTC(y, month, 1)).getUTCDay();
    return Date.UTC(y, month, 1 + ((7 - first) % 7) + (n - 1) * 7);
}
function ctOffsetMin(ms) {
    const y = new Date(ms).getUTCFullYear();
    const dstStart = nthSundayUtc(y, 2, 2) + 8 * 3600e3;   // 2nd Sun Mar, 02:00 CST
    const dstEnd   = nthSundayUtc(y, 10, 1) + 7 * 3600e3;  // 1st Sun Nov, 02:00 CDT
    return (ms >= dstStart && ms < dstEnd) ? -300 : -360;
}

// CT wall-clock time as a "local" epoch ms (read it with getUTC*), and back.
// An ambiguous local time (the repeated hour in November) takes CDT, as java.time does.
function toCT(ms) { return ms + ctOffsetMin(ms) * MIN; }
function fromCT(local) {
    const cdt = local + 300 * MIN;
    return ctOffsetMin(cdt) === -300 ? cdt : local + 360 * MIN;
}
function ctDay(ms) { return Math.floor(toCT(ms) / DAY); }
function ctMinute(ms) { const l = toCT(ms); return (l - Math.floor(l / DAY) * DAY) / MIN; }
function at(day, minute) { return fromCT(day * DAY + minute * MIN); }

const clock = {
    isRth(ms) { const m = ctMinute(ms); return m >= RTH_OPEN && m < GLOBEX_OPEN; },

    /** Open of the session containing `ms`. */
    sessionStart(ms) {
        const day = ctDay(ms), m = ctMinute(ms);
        return m < RTH_OPEN ? at(day - 1, GLOBEX_OPEN) : m < GLOBEX_OPEN ? at(day, RTH_OPEN) : at(day, GLOBEX_OPEN);
    },
    /** The first session open (08:30 or 17:00 CT) strictly after `ms`. */
    nextBoundary(ms) {
        const day = ctDay(ms), m = ctMinute(ms);
        return m < RTH_OPEN ? at(day, RTH_OPEN) : m < GLOBEX_OPEN ? at(day, GLOBEX_OPEN) : at(day + 1, RTH_OPEN);
    },
    /** Most recent occurrence of the CT time `minute` at or before `now`. */
    mostRecent(now, minute) {
        const t = at(ctDay(now), minute);
        return t > now ? at(ctDay(now) - 1, minute) : t;
    },
    /** The CT time `minute` on the CT date of `ms`. */
    atTime(ms, minute) { return at(ctDay(ms), minute); },
    /** Shifts by whole CT calendar days, keeping the wall-clock time (DST safe). */
    shiftDays(ms, n) { return fromCT(toCT(ms) + n * DAY); },
    dayOfWeek(ms) { return new Date(toCT(ms)).getUTCDay(); },
    isWeekday(ms) { const w = clock.dayOfWeek(ms); return w !== SAT && w !== SUN; },
    /** 17:00 CT on the eve of the first weekday of the month `offset` months from the month of `ms`. */
    monthOpen(ms, offset) {
        const d = new Date(toCT(ms));
        let first = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + offset, 1);
        while (new Date(first).getUTCDay() === SAT || new Date(first).getUTCDay() === SUN) first += DAY;
        return at(first / DAY - 1, GLOBEX_OPEN);
    },
    /** "Mon 09/29" */
    fmtDate(ms) {
        const d = new Date(toCT(ms));
        return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()] + " "
            + pad2(d.getUTCMonth() + 1) + "/" + pad2(d.getUTCDate());
    },
    /** "09/2026" */
    fmtMonth(ms) {
        const d = new Date(toCT(ms));
        return pad2(d.getUTCMonth() + 1) + "/" + d.getUTCFullYear();
    },
};
function pad2(n) { return (n < 10 ? "0" : "") + n; }

const SESSIONS = {
    RTH:    { label: "RTH",    hours: "08:30 - 17:00" },
    GLOBEX: { label: "Globex", hours: "17:00 - 08:30" },
};

// ── Historical Profile choices ─────────────────────────────────────────
const MAX_LOOKBACK_DAYS = 10;

function dayRange(start, end) {
    return clock.fmtDate(clock.shiftDays(start, 1)) + " - " + clock.fmtDate(end);
}

// The session that closed at `close` and the same session on each of the
// days before it, so sessions with no data can be skipped back to the last
// one that traded.
function previousSessions(close, session) {
    const out = [];
    for (let d = 0; d < MAX_LOOKBACK_DAYS; d++) {
        const end = clock.shiftDays(close, -d);
        const start = session === SESSIONS.GLOBEX
            ? clock.atTime(clock.shiftDays(end, -1), GLOBEX_OPEN)
            : clock.atTime(end, RTH_OPEN);
        out.push({ start, end, title: session.label + " " + clock.fmtDate(start) + " " + session.hours });
    }
    return out;
}

// anchor: the profile changes each time the chart passes this CT time.
// singleSession: windows that end before the chart's first bar are not looked at.
const HISTORICAL_MODES = {
    prevRth: {
        anchor: GLOBEX_OPEN, singleSession: true,
        candidates: close => previousSessions(close, SESSIONS.RTH),
    },
    prevGlobex: {
        anchor: RTH_OPEN, singleSession: true,
        candidates: close => previousSessions(close, SESSIONS.GLOBEX),
    },
    // The five most recently closed trading days; days closing on a weekend are stepped over.
    last5Days: {
        anchor: GLOBEX_OPEN, singleSession: false,
        candidates(dayOpen) {
            let end = 0, start = 0;
            for (let close = dayOpen, days = 0; days < 5; close = clock.shiftDays(close, -1)) {
                if (!clock.isWeekday(close)) continue;
                if (days++ === 0) end = close;
                start = clock.shiftDays(close, -1);
            }
            return [{ start, end, title: "5-Day " + dayRange(start, end) }];
        },
    },
    // The trading week before the current one: Sunday 17:00 to Friday 17:00.
    lastWeek: {
        anchor: GLOBEX_OPEN, singleSession: false,
        candidates(dayOpen) {
            let weekOpen = dayOpen;
            while (clock.dayOfWeek(weekOpen) !== SUN) weekOpen = clock.shiftDays(weekOpen, -1);
            const start = clock.shiftDays(weekOpen, -7);
            const end = clock.shiftDays(start, 5);
            return [{ start, end, title: "Week " + dayRange(start, end) }];
        },
    },
    // The month before the current trading day's month. A month opens at
    // 17:00 on the eve of its first weekday.
    lastMonth: {
        anchor: GLOBEX_OPEN, singleSession: false,
        candidates(dayOpen) {
            let tradingDate = clock.shiftDays(dayOpen, 1);
            while (!clock.isWeekday(tradingDate)) tradingDate = clock.shiftDays(tradingDate, 1);
            const start = clock.monthOpen(tradingDate, -1);
            const end = clock.monthOpen(tradingDate, 0);
            return [{ start, end, title: "Month " + clock.fmtMonth(clock.shiftDays(start, 1)) }];
        },
    },
};

const SIDES = {
    historical: { historical: true,  active: false },
    active:     { historical: false, active: true },
    both:       { historical: true,  active: true },
    none:       { historical: false, active: false },
};
const FILL_ALPHA = { ghost: 0, mid: 128, full: 255 };

// ── ProfileSnapshot ────────────────────────────────────────────────────
const MAX_ROWS = 20000;        // a profile taller than this is not drawn
const MAX_BAR_SPAN = 20000;    // a bar spanning more ticks than this is bad data

/** The row a tick bin falls in when rows are `rowTicks` ticks tall: round(bin / rowTicks). */
function rowOf(bin, rowTicks) {
    return Math.floor((2 * bin + rowTicks) / (2 * rowTicks));
}
function roundToTick(price, tick) { return Math.round(price / tick) * tick; }

/**
 * The session histograms combined into rows `rowTicks` ticks tall, with the
 * POC and the Value Area, and the delta per row when any bar carried a
 * bid/ask split. Null if they hold no volume. The Value Area starts at the
 * POC row and repeatedly adds whichever adjacent row has more volume (ties go
 * up) until it holds vaPct% of the total; empty edge rows are then trimmed.
 */
function snapshotOf(hists, rowTicks, tick, vaPct) {
    let minBin = Infinity, maxBin = -Infinity, withDelta = false;
    for (const h of hists) {
        for (const [bin, c] of h.bins) {
            if (c.v === 0 && c.d === 0) continue;
            if (bin < minBin) minBin = bin;
            if (bin > maxBin) maxBin = bin;
        }
        withDelta = withDelta || h.deltaBars > 0;
    }
    if (minBin > maxBin) return null;

    const minRow = rowOf(minBin, rowTicks);
    const n = rowOf(maxBin, rowTicks) - minRow + 1;
    if (n <= 0 || n > MAX_ROWS) return null;

    const vols = new Array(n).fill(0);
    const deltas = withDelta ? new Array(n).fill(0) : null;
    for (const h of hists) {
        for (const [bin, c] of h.bins) {
            const r = rowOf(bin, rowTicks) - minRow;
            vols[r] += c.v;
            if (deltas) deltas[r] += c.d;
        }
    }

    let poc = 0, total = 0;
    for (let i = 0; i < n; i++) {
        total += vols[i];
        if (vols[i] > vols[poc]) poc = i;
    }
    if (vols[poc] <= 0) return null;

    const target = total * (vaPct / 100);
    let acc = vols[poc], hi = poc, lo = poc, up = poc + 1, dn = poc - 1;
    while (acc < target && (up < n || dn >= 0)) {
        const uv = up < n ? vols[up] : -1;
        const dv = dn >= 0 ? vols[dn] : -1;
        if (uv >= dv) { acc += Math.max(0, uv); hi = up; up++; }
        else          { acc += Math.max(0, dv); lo = dn; dn--; }
    }
    while (hi > poc && vols[hi] <= 0) hi--;
    while (lo < poc && vols[lo] <= 0) lo++;

    const rowSize = tick * rowTicks;
    const price = i => (minRow + i) * rowSize;
    let maxAbsDelta = 0, maxDeltaIdx = 0, totalDelta = 0;
    if (deltas) {
        for (let i = 0; i < n; i++) {
            totalDelta += deltas[i];
            if (Math.abs(deltas[i]) > maxAbsDelta) { maxAbsDelta = Math.abs(deltas[i]); maxDeltaIdx = i; }
        }
    }
    return {
        minRow, rowSize, vols, maxVol: vols[poc],
        pocIdx: poc, vaLo: lo, vaHi: hi,
        poc: roundToTick(price(poc), tick), vah: roundToTick(price(hi), tick), val: roundToTick(price(lo), tick),
        deltas, maxAbsDelta, maxDeltaIdx, totalDelta,
        hasDelta: deltas !== null && maxAbsDelta > 0,
        rows: n,
        price,
        floor: i => (minRow + i) * rowSize - rowSize / 2,   // bottom edge of row i
    };
}

function signed(x) {
    const v = Math.round(x);
    return (v > 0 ? "+" : "") + v;
}

// ── Drawing ────────────────────────────────────────────────────────────
// Everything that depends on how Tradovate places frame-anchored graphics is
// in this block, so it can be adjusted in one place.
const PROFILE_WIDTH_PX = 250;
const LABEL_PAD = 4, ROW_VALUE_PAD = 3, LINE_H = 14, FONT_SIZE = 11;
const ROW_TEXT_MIN_PX = 12;    // a row's delta is printed when the row is at least this tall

const OUTLINE_WHITE = [0xE6, 0xE6, 0xE6];
const VA_BLUE       = [0x1E, 0x90, 0xFF];
const LEVEL_YELLOW  = [0xFF, 0xD5, 0x00];
const DELTA_POS     = [0x28, 0xC7, 0x6F];
const DELTA_NEG     = [0xE5, 0x39, 0x35];
const TEXT          = [0xD0, 0xD0, 0xD0];
const DELTA_ALPHA = 150, DELTA_PEAK_ALPHA = 230;

function rgba(c, a = 255) { return "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + (a / 255).toFixed(3) + ")"; }

// LEFT bars grow rightward from the left plot edge, RIGHT leftward from the right edge.
const EDGES = {
    left:  { dir: +1, h: "left",  near: "left" },
    right: { dir: -1, h: "right", near: "right" },
};
// x is measured in pixels from the edge, y in price.
function origin(edge) { return { cs: "frame", h: edge.h }; }
function pt(edge, xPx, y) { return { x: px(xPx), y }; }
// Screen offsets from a price; assumes px on the y axis grows downward, as on a canvas.
function above(price, n) { return op(du(price), "-", px(n)); }
function below(price, n) { return op(du(price), "+", px(n)); }

function item(edge, key, body) {
    return Object.assign({ key, global: true, origin: origin(edge) }, body);
}
function text(edge, key, x, y, str, color, vAlign, conditions) {
    return item(edge, key, Object.assign({
        tag: "Text",
        point: pt(edge, x, y),
        text: str,
        style: { fontSize: FONT_SIZE, fill: rgba(color) },
        textAlignment: edge.near + vAlign,               // e.g. "leftBottom", "rightMiddle"
    }, conditions ? { conditions } : {}));
}
function rect(edge, len, topPrice, rowSize) {
    return {
        tag: "Rectangle",
        position: { x: px(edge.dir > 0 ? 0 : -len), y: du(topPrice) },
        size: { width: px(len), height: du(rowSize) },
    };
}

/** One edge's items, bottom layer first: volume body, outline, delta rows, VA lines, labels. */
function buildItems(s, edge, side, title, fill, showVolume, showDelta, decimals) {
    const items = [], k = "pl-" + side + "-";
    const W = PROFILE_WIDTH_PX, dir = edge.dir;
    const len = i => Math.round(s.vols[i] / s.maxVol * W);

    if (showVolume) {
        const alpha = FILL_ALPHA[fill] || 0;
        if (alpha > 0) {
            const body = [], poc = [];
            for (let i = 0; i < s.rows; i++) {
                const l = len(i);
                if (l > 0) (i === s.pocIdx ? poc : body).push(rect(edge, l, s.floor(i + 1), s.rowSize));
            }
            items.push(item(edge, k + "body", { tag: "Shapes", primitives: body, fillStyle: { color: rgba(OUTLINE_WHITE, alpha) } }));
            items.push(item(edge, k + "poc", { tag: "Shapes", primitives: poc, fillStyle: { color: rgba(LEVEL_YELLOW, alpha) } }));
        }

        // Stepped outline along the row tips, top row first, closed to the base at top and bottom.
        const pts = [[0, s.floor(s.rows)]];
        for (let i = s.rows - 1; i >= 0; i--) {
            const x = dir * len(i);
            pts.push([x, s.floor(i + 1)], [x, s.floor(i)]);
        }
        pts.push([0, s.floor(0)]);
        items.push(item(edge, k + "outline", {
            tag: "LineSegments",
            lines: polyline(pts).map(([a, b]) => ({ tag: "Line", a: pt(edge, a[0], du(a[1])), b: pt(edge, b[0], du(b[1])) })),
            lineStyle: { lineWidth: 1, color: rgba(OUTLINE_WHITE) },
        }));
    }

    if (showDelta && s.hasDelta) {
        const groups = { pos: [], neg: [], posPeak: [], negPeak: [] };
        const labels = [];
        const dlen = i => Math.round(Math.abs(s.deltas[i]) / s.maxAbsDelta * W);
        let low = -1;
        for (let i = 0; i < s.rows; i++) {
            const l = dlen(i);
            if (l <= 0) continue;
            if (low < 0) low = i;
            const g = (s.deltas[i] > 0 ? "pos" : "neg") + (i === s.maxDeltaIdx ? "Peak" : "");
            groups[g].push(rect(edge, l, s.floor(i + 1), s.rowSize));
            labels.push(text(edge, k + "dv" + i, dir * ROW_VALUE_PAD, du(s.price(i)), signed(s.deltas[i]), TEXT, "Middle",
                { scaleRangeY: { min: ROW_TEXT_MIN_PX / s.rowSize } }));
        }
        const fills = {
            pos: rgba(DELTA_POS, DELTA_ALPHA), neg: rgba(DELTA_NEG, DELTA_ALPHA),
            posPeak: rgba(DELTA_POS, DELTA_PEAK_ALPHA), negPeak: rgba(DELTA_NEG, DELTA_PEAK_ALPHA),
        };
        for (const g of Object.keys(groups)) {
            if (groups[g].length) items.push(item(edge, k + "delta-" + g, { tag: "Shapes", primitives: groups[g], fillStyle: { color: fills[g] } }));
        }
        items.push(...labels);
        if (low >= 0) {
            items.push(text(edge, k + "dtotal", dir * LABEL_PAD, below(s.floor(low), LABEL_PAD),
                "Δ " + signed(s.totalDelta), s.totalDelta >= 0 ? DELTA_POS : DELTA_NEG, "Top"));
        }
    }

    if (showVolume) {
        items.push(item(edge, k + "va", {
            tag: "LineSegments",
            lines: [s.vah, s.val].map(p => ({ tag: "Line", a: pt(edge, 0, du(p)), b: pt(edge, dir * W, du(p)) })),
            lineStyle: { lineWidth: 1, color: rgba(VA_BLUE) },
        }));
        const top = s.floor(s.rows);
        const levels = "VAH " + s.vah.toFixed(decimals) + " | POC " + s.poc.toFixed(decimals) + " | VAL " + s.val.toFixed(decimals);
        items.push(text(edge, k + "title", dir * LABEL_PAD, above(top, LABEL_PAD + LINE_H), title, TEXT, "Bottom"));
        items.push(text(edge, k + "levels", dir * LABEL_PAD, above(top, LABEL_PAD), levels, TEXT, "Bottom"));
    }
    return items;
}

/** Consecutive segments of a path, dropping repeated points and joining straight runs. */
function polyline(pts) {
    const p = [];
    for (const q of pts) {
        const last = p[p.length - 1];
        if (last && last[0] === q[0] && last[1] === q[1]) continue;
        const prev = p[p.length - 2];
        if (prev && ((prev[0] === last[0] && last[0] === q[0]) || (prev[1] === last[1] && last[1] === q[1]))) p.pop();
        p.push(q);
    }
    const segs = [];
    for (let i = 1; i < p.length; i++) segs.push([p[i - 1], p[i]]);
    return segs;
}

function decimalsOf(tick) {
    const s = String(tick);
    const dot = s.indexOf(".");
    return dot < 0 ? 0 : Math.min(8, s.length - dot - 1);
}

// ── ProfileModule ──────────────────────────────────────────────────────
const LIVE_UPDATE_MS = 1000;   // the live profile's graphics are rebuilt at most once a second

// Shared with SystemOne. Settings read from opts:
//   volumeProfiles, deltaProfiles: "historical" | "active" | "both" | "none"
//   historicalProfile: a HISTORICAL_MODES key
//   ticksPerRow, valueAreaPercent, profileFill ("ghost" | "mid" | "full")
function profileModule() {
    let tick, sessions, recent, firstTime, views;

    function reset() {
        sessions = new Map();     // session start -> { bins: Map(bin -> { v, d }), deltaBars, rev }
        recent = new Map();       // bar index -> what that bar added, so a re-mapped bar replaces it
        firstTime = Infinity;
        views = {};
    }

    function apply(c, sign) {
        const h = sessions.get(c.key);
        for (const [bin, v, d] of c.entries) {
            const cell = h.bins.get(bin);
            cell.v += sign * v;
            cell.d += sign * d;
            if (sign < 0 && Math.abs(cell.v) < 1e-9 && Math.abs(cell.d) < 1e-9) h.bins.delete(bin);
        }
        if (c.withDelta) h.deltaBars += sign;
        h.rev++;
    }

    /** Adds bar i to its session's histogram, replacing what an earlier call for bar i added. */
    function accumulate(d, i, t) {
        const old = recent.get(i);
        if (old) apply(old, -1);

        const key = clock.sessionStart(t);
        if (!sessions.has(key)) sessions.set(key, { bins: new Map(), deltaBars: 0, rev: 0 });
        const h = sessions.get(key);

        const entries = [];
        const levels = (typeof d.profile === "function" && d.profile()) || [];
        let withDelta = false;
        for (const lv of levels) {
            if (!(lv.price > 0) || !(lv.vol > 0)) continue;
            const bid = lv.bidVol || 0, ask = lv.askVol || 0;
            entries.push([Math.floor(lv.price / tick + 0.5), lv.vol, ask - bid]);
            withDelta = true;
        }
        if (!withDelta) {                                 // no volume at price: spread the bar
            const vol = d.volume();
            const b1 = Math.floor(d.low() / tick + 0.5), b2 = Math.floor(d.high() / tick + 0.5);
            if (vol > 0 && b2 >= b1 && b2 - b1 <= MAX_BAR_SPAN) {
                const per = vol / (b2 - b1 + 1);
                for (let b = b1; b <= b2; b++) entries.push([b, per, 0]);
            }
        }
        const merged = new Map();                         // one entry per bin
        for (const [bin, v, dl] of entries) {
            const m = merged.get(bin);
            if (m) { m[1] += v; m[2] += dl; } else merged.set(bin, [bin, v, dl]);
            if (!h.bins.has(bin)) h.bins.set(bin, { v: 0, d: 0 });
        }
        const c = { key, entries: [...merged.values()], withDelta };
        apply(c, +1);

        recent.set(i, c);
        for (const j of recent.keys()) if (j < i - 1) recent.delete(j);
    }

    /** The histograms of the sessions in [w.start, w.end) that hold data. */
    function partsOf(w) {
        const out = [];
        for (let t = w.start; t < w.end; t = clock.nextBoundary(t)) {
            const h = sessions.get(t);
            if (h && h.bins.size > 0) out.push({ start: t, h });
        }
        return out;
    }

    /** One edge's items, rebuilt only when what they show changed. */
    function edgeItems(side, windows, stopAtHistory, showVolume, showDelta, opts, live, wall) {
        if (!showVolume && !showDelta) return [];
        let w = null, parts = [];
        for (const c of windows) {
            if (stopAtHistory && c.end <= firstTime) break;    // past loaded history
            parts = partsOf(c);
            if (parts.length) { w = c; break; }
        }
        const view = views[side] || (views[side] = { shape: null, revs: null, items: [], built: 0 });
        if (!w) { view.shape = null; view.items = []; return view.items; }

        const shape = [w.start, w.end, w.title, showVolume, showDelta,
            opts.ticksPerRow, opts.valueAreaPercent, opts.profileFill].join("|");
        const revs = parts.map(p => p.start + ":" + p.h.rev).join(",");
        if (shape === view.shape && revs === view.revs) return view.items;
        if (shape === view.shape && live && wall - view.built < LIVE_UPDATE_MS) return view.items;

        const rowTicks = Math.min(400, Math.max(1, Math.round(opts.ticksPerRow) || 1));
        const vaPct = Math.min(99, Math.max(10, Math.round(opts.valueAreaPercent) || 70));
        const s = snapshotOf(parts.map(p => p.h), rowTicks, tick, vaPct);
        view.shape = shape;
        view.revs = revs;
        view.built = wall;
        view.snapshot = s;
        view.title = w.title;
        view.items = s ? buildItems(s, EDGES[side], side, w.title, opts.profileFill, showVolume, showDelta, decimalsOf(tick)) : [];
        return view.items;
    }

    return {
        name: "Profiles",
        init() { tick = undefined; reset(); },
        /** The views as last built, for tests. */
        views() { return views; },
        map(d, i, history, opts, contractInfo) {
            const tickSize = contractInfo && contractInfo.tickSize;
            if (!(tickSize > 0)) return {};
            if (tickSize !== tick) { tick = tickSize; reset(); }

            const t = d.timestamp().getTime();
            if (t < firstTime) firstTime = t;
            accumulate(d, i, t);
            if (i !== history.size() - 1) return {};     // all drawing happens on the last bar

            const wall = Date.now();
            const sessionStart = clock.sessionStart(t);
            const sessionEnd = clock.nextBoundary(sessionStart);
            const volumes = SIDES[opts.volumeProfiles] || SIDES.both;
            const deltas = SIDES[opts.deltaProfiles] || SIDES.both;
            const mode = HISTORICAL_MODES[opts.historicalProfile] || HISTORICAL_MODES.prevRth;

            const left = edgeItems("left",
                mode.candidates(clock.mostRecent(sessionStart, mode.anchor)), mode.singleSession,
                volumes.historical, deltas.historical, opts, false, wall);
            const current = {
                start: sessionStart, end: sessionEnd,
                title: (clock.isRth(sessionStart) ? "RTH" : "Globex") + " " + clock.fmtDate(sessionStart) + " (current)",
            };
            const right = edgeItems("right", [current], false,
                volumes.active, deltas.active, opts, true, wall);

            return { graphics: { items: left.concat(right) } };
        },
    };
}

class profileLevels {
    init() {
        this.profiles = profileModule();
        this.profiles.init();
    }
    map(d, i, history) {
        return this.profiles.map(d, i, history, this.props, this.contractInfo);
    }
}

const SIDE_CHOICES = { historical: "Historical", active: "Active", both: "Both", none: "None" };

module.exports = {
    name: "ProfileLevels",
    description: "Volume and delta profiles of a previous session, week or month pinned to the left edge of the chart and of the current session pinned to the right edge.",
    calculator: profileLevels,
    inputType: meta.InputType.BARS,
    areaChoice: meta.AreaChoice.OVERLAY,
    requirements: { volumeProfiles: true },
    tags: ["Servonitus"],
    params: {
        volumeProfiles: predef.paramSpecs.enum(SIDE_CHOICES, "both"),
        deltaProfiles: predef.paramSpecs.enum(SIDE_CHOICES, "both"),
        historicalProfile: predef.paramSpecs.enum({
            prevRth: "Previous RTH", prevGlobex: "Previous Globex", last5Days: "Last 5-Days",
            lastWeek: "Last Week", lastMonth: "Last Month",
        }, "prevRth"),
        ticksPerRow: predef.paramSpecs.number(1, 1, 1),            // 1 to 400
        valueAreaPercent: predef.paramSpecs.number(70, 1, 10),     // 10 to 99
        profileFill: predef.paramSpecs.enum({ ghost: "Ghost", mid: "Mid", full: "Full" }, "ghost"),
    },
};
