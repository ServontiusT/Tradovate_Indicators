/**
 * AVWAP Anchor — Tradovate custom DRAWING TOOL
 * -------------------------------------------------------------------------
 * Companion to the "Anchored VWAP" indicator (AnchoredVWAP.js).
 *
 * Click a bar to drop a vertical marker. SHIFT-hover the marker to read the
 * bar index, then type that index into the indicator's "Anchor bar index"
 * field (with Anchor mode = Bar index). The indicator will then print the
 * resolved date/time on the chart so you can promote the anchor to a durable
 * timestamp — see the workflow notes in AnchoredVWAP.js.
 *
 * Why the handoff is a bar index and not a timestamp: a drawing tool's
 * anchor X coordinate is expressed in domain units, and on the X axis a
 * domain unit IS the bar index. Drawing tools receive only
 * {anchors, props, state, plots} — no access to the bar series — so there is
 * no way for this file to turn that index into a date. Only the indicator,
 * which does receive bars, can do that.
 *
 * Setup: Code Explorer -> File -> New, paste, save. The tool then appears in
 * the chart's drawing-tool selector under "My Tools".
 */

const predef = require("./tools/predef");
const { px, du, op } = require("./tools/graphics");

// Half-height of the vertical marker, in pixels. Pixel units are used rather
// than a huge price range so the marker cannot influence price-axis scaling.
const HALF_HEIGHT_PX = 4000;

function anchorIndexOf(anchors) {
    if (!anchors || !anchors[0] || !anchors[0].x) {
        return undefined;
    }
    const raw = anchors[0].x.value;
    return typeof raw === "number" && isFinite(raw) ? Math.round(raw) : undefined;
}

const avwapAnchor = {
    render({ anchors, props }) {
        if (!anchors || !anchors[0]) {
            return { items: [] };
        }

        const base = anchors[0];
        const items = [
            {
                tag: "LineSegments",
                key: "anchorLine",
                lines: [
                    {
                        tag: "Line",
                        a: { x: base.x, y: op(du(base.y.value), "-", px(HALF_HEIGHT_PX)) },
                        b: { x: base.x, y: op(du(base.y.value), "+", px(HALF_HEIGHT_PX)) }
                    }
                ],
                lineStyle: {
                    lineWidth: props.lineWidth,
                    color: props.lineColor,
                    lineStyle: props.dashed ? 3 : 1
                }
            }
        ];

        if (props.showLabel) {
            const index = anchorIndexOf(anchors);
            items.push({
                tag: "Text",
                key: "anchorLabel",
                point: {
                    x: base.x,
                    y: op(du(base.y.value), "-", px(18))
                },
                text: index === undefined ? "AVWAP" : "AVWAP idx " + index,
                style: { fontSize: 11, fontWeight: "bold", fill: props.lineColor },
                textAlignment: "centerMiddle"
            });
        }

        return { items: items };
    },

    tooltips({ anchors }) {
        if (!anchors || !anchors[0]) {
            return [];
        }

        const index = anchorIndexOf(anchors);

        return [
            {
                coord: anchors[0],
                alignment: { tag: "predef", x: "right", y: "above" },
                items: [
                    { key: "title", content: "AVWAP anchor" },
                    {
                        key: "barIndex",
                        title: "Bar index: ",
                        content: index === undefined ? "n/a" : index
                    },
                    {
                        key: "price",
                        title: "Price: ",
                        content: anchors[0].y.value
                    }
                ]
            }
        ];
    },

    anchorStyles({ props }) {
        return [{ color: props.lineColor }];
    }
};

module.exports = {
    name: "avwapAnchor",
    description: "AVWAP Anchor",
    drawing: avwapAnchor,
    tags: ["My Tools"],
    params: {
        lineColor: predef.paramSpecs.color("#f0a020"),
        lineWidth: predef.paramSpecs.number(1, 1, 1),
        dashed: predef.paramSpecs.bool(true),
        showLabel: predef.paramSpecs.bool(true)
    },
    minN: 1,
    maxN: 1
};