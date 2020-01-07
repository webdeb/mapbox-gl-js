// @flow

import Point from '@mapbox/point-geometry';

import * as intersectionTests from '../util/intersection_tests';
import Grid from './grid_index';
import {mat4} from 'gl-matrix';

import * as projection from '../symbol/projection';

import type Transform from '../geo/transform';
import type {SingleCollisionBox} from '../data/bucket/symbol_bucket';
import type {
    GlyphOffsetArray,
    SymbolLineVertexArray
} from '../data/array_types';

// When a symbol crosses the edge that causes it to be included in
// collision detection, it will cause changes in the symbols around
// it. This constant specifies how many pixels to pad the edge of
// the viewport for collision detection so that the bulk of the changes
// occur offscreen. Making this constant greater increases label
// stability, but it's expensive.
const viewportPadding = 100;

/**
 * A collision index used to prevent symbols from overlapping. It keep tracks of
 * where previous symbols have been placed and is used to check if a new
 * symbol overlaps with any previously added symbols.
 *
 * There are two steps to insertion: first placeCollisionBox/Circles checks if
 * there's room for a symbol, then insertCollisionBox/Circles actually puts the
 * symbol in the index. The two step process allows paired symbols to be inserted
 * together even if they overlap.
 *
 * @private
 */
class CollisionIndex {
    grid: Grid;
    ignoredGrid: Grid;
    transform: Transform;
    pitchfactor: number;
    screenRightBoundary: number;
    screenBottomBoundary: number;
    gridRightBoundary: number;
    gridBottomBoundary: number;

    constructor(
        transform: Transform,
        grid: Grid = new Grid(transform.width + 2 * viewportPadding, transform.height + 2 * viewportPadding, 25),
        ignoredGrid: Grid = new Grid(transform.width + 2 * viewportPadding, transform.height + 2 * viewportPadding, 25)
    ) {
        this.transform = transform;

        this.grid = grid;
        this.ignoredGrid = ignoredGrid;
        this.pitchfactor = Math.cos(transform._pitch) * transform.cameraToCenterDistance;

        this.screenRightBoundary = transform.width + viewportPadding;
        this.screenBottomBoundary = transform.height + viewportPadding;
        this.gridRightBoundary = transform.width + 2 * viewportPadding;
        this.gridBottomBoundary = transform.height + 2 * viewportPadding;
    }

    placeCollisionBox(collisionBox: SingleCollisionBox, allowOverlap: boolean, textPixelRatio: number, posMatrix: mat4, collisionGroupPredicate?: any): { box: Array<number>, offscreen: boolean } {
        const projectedPoint = this.projectAndGetPerspectiveRatio(posMatrix, collisionBox.anchorPointX, collisionBox.anchorPointY);
        const tileToViewport = textPixelRatio * projectedPoint.perspectiveRatio;
        const tlX = collisionBox.x1 * tileToViewport + projectedPoint.point.x;
        const tlY = collisionBox.y1 * tileToViewport + projectedPoint.point.y;
        const brX = collisionBox.x2 * tileToViewport + projectedPoint.point.x;
        const brY = collisionBox.y2 * tileToViewport + projectedPoint.point.y;

        if (!this.isInsideGrid(tlX, tlY, brX, brY) ||
            (!allowOverlap && this.grid.hitTest(tlX, tlY, brX, brY, collisionGroupPredicate))) {
            return {
                box: [],
                offscreen: false
            };
        }

        return {
            box: [tlX, tlY, brX, brY],
            offscreen: this.isOffscreen(tlX, tlY, brX, brY)
        };
    }

    clipLine(start: Point, end: Point, minBoundary: Point, maxBoundary: Point) {
        const LEFT   = 1 << 0;
        const RIGHT  = 1 << 1;
        const BOTTOM = 1 << 2;
        const TOP    = 1 << 3;

        const epsilon = 0.00001;

        // Compute region codes for both points
        const computeRegion = (point, min, max) => {
            let region = 0;

            region |= LEFT * (point.x < min.x);
            region |= RIGHT * (point.x > max.x);
            region |= TOP * (point.y < min.y);      // top left of the screen is (0, 0)
            region |= BOTTOM *(point.y > max.y);

            return region;
        };

        const startRegion = computeRegion(start, minBoundary, maxBoundary);
        const endRegion = computeRegion(end, minBoundary, maxBoundary);

        // Both inside boundaries already?
        if (!startRegion && !endRegion)
            return [start, end];

        // Both point outside of the region and inside a same region?
        if (startRegion === endRegion)
            return null;

        // Perform segment-"aabb slab" intersection test to find precise intersection points
        let tMin = 0.0;
        let tMax = Number.MAX_VALUE;

        const startToEnd = end.sub(start);
        const len = startToEnd.mag();

        if (len < epsilon)
            return [start, end];

        const dir = startToEnd.div(len);

        const slabCheckOnAxis = (dirVec, minVec, maxVec, startVec) => {
            if (Math.abs(dirVec) < epsilon) {
                // Ray is parallel to the slab
                if (startVec < minVec || startVec > maxVec) {
                    return false;
                }
            } else {
                const ood = 1.0 / dirVec;

                let t1 = (minVec - startVec) * ood;
                let t2 = (maxVec - startVec) * ood;

                if (t1 > t2) {
                    const temp = t1;
                    t1 = t2;
                    t2 = temp;
                }

                // Compute intersection
                if (t1 > tMin) tMin = t1;
                if (t2 < tMax) tMax = t2;

                if (tMin > tMax || tMax < 0)
                    return false;
            }

            return true;
        }

        // Perform slab check on both x and y axes
        if (!slabCheckOnAxis(dir.x, minBoundary.x, maxBoundary.x, start.x))
            return null;

        if (!slabCheckOnAxis(dir.y, minBoundary.y, maxBoundary.y, start.y))
            return null;

        tMin = Math.min(tMin, len);
        tMax = Math.min(tMax, len);

        return [start.add(startToEnd.mult(tMin / len)), start.add(startToEnd.mult(tMax / len))];
    }

    placeCollisionCircles(collisionCircles: Array<number>,
                          allowOverlap: boolean,
                          scale: number,
                          textPixelRatio: number,
                          symbol: any,
                          lineVertexArray: SymbolLineVertexArray,
                          glyphOffsetArray: GlyphOffsetArray,
                          fontSize: number,
                          posMatrix: mat4,
                          labelPlaneMatrix: mat4,
                          showCollisionCircles: boolean,
                          pitchWithMap: boolean,
                          collisionGroupPredicate?: any): { circles: Array<number>, offscreen: boolean } {
        const placedCollisionCircles = [];

        const projectedAnchor = this.projectAnchor(posMatrix, symbol.anchorX, symbol.anchorY);

        const tileUnitAnchorPoint = new Point(symbol.anchorX, symbol.anchorY);
        // projection.project generates NDC coordinates, as opposed to the
        // pixel-based grid coordinates generated by this.projectPoint
        const labelPlaneAnchorPoint =
        projection.project(tileUnitAnchorPoint, labelPlaneMatrix).point;

        const projectionCache = {};
        const fontScale = fontSize * projectedAnchor.perspectiveRatio / 24;
        const lineOffsetX = symbol.lineOffsetX * fontScale;
        const lineOffsetY = symbol.lineOffsetY * fontScale;

        const firstAndLastGlyph = projection.placeFirstAndLastGlyph(
            fontScale,
            glyphOffsetArray,
            lineOffsetX,
            lineOffsetY,
            /*flip*/ false,
            labelPlaneAnchorPoint,
            tileUnitAnchorPoint,
            symbol,
            lineVertexArray,
            labelPlaneMatrix,
            projectionCache,
            /*return tile distance*/ true);

        let collisionDetected = false;
        let inGrid = false;
        let entirelyOffscreen = true;

        if (firstAndLastGlyph) {
            const circles = [];

            const addCircle = (point, radius) => {
                circles.push({ point, radius });
                return circles.length - 1;
            };

            const radius = 10 * projectedAnchor.perspectiveRatio;

            let lastPlacedCircle = null;

            const labelPlaneMin = new Point(0, 0);
            const labelPlaneMax = new Point(this.transform.width, this.transform.height);

            // Construct projected path from projected line vertices. Anchor points are ignored and removed
            const first = firstAndLastGlyph.first;
            const last = firstAndLastGlyph.last;

            const projectedPath = first.path.slice(1).reverse().concat(last.path.slice(1));

            for (let segIdx = 0; segIdx < projectedPath.length - 1; segIdx++) {
                const startIdx = segIdx;
                const endIdx = segIdx + 1;

                const clippedLine = this.clipLine(projectedPath[startIdx], projectedPath[endIdx], labelPlaneMin, labelPlaneMax);

                if (!clippedLine)
                    // This segment is not visible on the screen
                    continue;

                const startPoint = clippedLine[0];
                const endPoint = clippedLine[1];

                // Always place collision circles on first and last points of the segment unless the path is continuous.
                // Clipping against label plane boundaries might cause discontinuouties that must be taken into account
                if (!lastPlacedCircle || lastPlacedCircle.dist(startPoint) >= 2.0 * radius) {
                    addCircle(startPoint, radius);
                }

                addCircle(endPoint, radius);
                lastPlacedCircle = endPoint;

                const startToEnd = endPoint.sub(startPoint);
                const segLen = startToEnd.mag();
                const circlesInSegment = Math.ceil(segLen / (2.0 * radius)) - 1;
                const circleToCircle = startToEnd.div(circlesInSegment + 1);

                for (let i = 1; i <= circlesInSegment; i++) {
                    addCircle(startPoint.add(circleToCircle.mult(i)), radius);
                }
            }

            for (const circle of circles) {
                const px = circle.point.x + viewportPadding;
                const py = circle.point.y + viewportPadding;

                placedCollisionCircles.push(px, py, circle.radius, 0);

                const x1 = px - circle.radius;
                const y1 = py - circle.radius;
                const x2 = px + circle.radius;
                const y2 = py + circle.radius;

                entirelyOffscreen = entirelyOffscreen && this.isOffscreen(x1, y1, x2, y2);
                inGrid = inGrid || this.isInsideGrid(x1, y1, x2, y2);

                if (!allowOverlap) {
                    if (this.grid.hitTestCircle(px, py, circle.radius, collisionGroupPredicate)) {
                        if (!showCollisionCircles) {
                            return {
                                circles: [],
                                offscreen: false
                            };
                        } else {
                            // Don't early exit if we're showing the debug circles because we still want to calculate
                            // which circles are in use
                            collisionDetected = true;
                        }
                    }
                }
            }
        }

        return {
            circles: (collisionDetected || !inGrid) ? [] : placedCollisionCircles,
            offscreen: entirelyOffscreen
        };
    }

    /**
     * Because the geometries in the CollisionIndex are an approximation of the shape of
     * symbols on the map, we use the CollisionIndex to look up the symbol part of
     * `queryRenderedFeatures`.
     *
     * @private
     */
    queryRenderedSymbols(viewportQueryGeometry: Array<Point>) {
        if (viewportQueryGeometry.length === 0 || (this.grid.keysLength() === 0 && this.ignoredGrid.keysLength() === 0)) {
            return {};
        }

        const query = [];
        let minX = Infinity;
        let minY = Infinity;
        let maxX = -Infinity;
        let maxY = -Infinity;
        for (const point of viewportQueryGeometry) {
            const gridPoint = new Point(point.x + viewportPadding, point.y + viewportPadding);
            minX = Math.min(minX, gridPoint.x);
            minY = Math.min(minY, gridPoint.y);
            maxX = Math.max(maxX, gridPoint.x);
            maxY = Math.max(maxY, gridPoint.y);
            query.push(gridPoint);
        }

        const features = this.grid.query(minX, minY, maxX, maxY)
            .concat(this.ignoredGrid.query(minX, minY, maxX, maxY));

        const seenFeatures = {};
        const result = {};

        for (const feature of features) {
            const featureKey = feature.key;
            // Skip already seen features.
            if (seenFeatures[featureKey.bucketInstanceId] === undefined) {
                seenFeatures[featureKey.bucketInstanceId] = {};
            }
            if (seenFeatures[featureKey.bucketInstanceId][featureKey.featureIndex]) {
                continue;
            }

            // Check if query intersects with the feature box
            // "Collision Circles" for line labels are treated as boxes here
            // Since there's no actual collision taking place, the circle vs. square
            // distinction doesn't matter as much, and box geometry is easier
            // to work with.
            const bbox = [
                new Point(feature.x1, feature.y1),
                new Point(feature.x2, feature.y1),
                new Point(feature.x2, feature.y2),
                new Point(feature.x1, feature.y2)
            ];
            if (!intersectionTests.polygonIntersectsPolygon(query, bbox)) {
                continue;
            }

            seenFeatures[featureKey.bucketInstanceId][featureKey.featureIndex] = true;
            if (result[featureKey.bucketInstanceId] === undefined) {
                result[featureKey.bucketInstanceId] = [];
            }
            result[featureKey.bucketInstanceId].push(featureKey.featureIndex);
        }

        return result;
    }

    insertCollisionBox(collisionBox: Array<number>, ignorePlacement: boolean, bucketInstanceId: number, featureIndex: number, collisionGroupID: number) {
        const grid = ignorePlacement ? this.ignoredGrid : this.grid;

        const key = {bucketInstanceId, featureIndex, collisionGroupID};
        grid.insert(key, collisionBox[0], collisionBox[1], collisionBox[2], collisionBox[3]);
    }

    insertCollisionCircles(collisionCircles: Array<number>, ignorePlacement: boolean, bucketInstanceId: number, featureIndex: number, collisionGroupID: number) {
        const grid = ignorePlacement ? this.ignoredGrid : this.grid;

        const key = {bucketInstanceId, featureIndex, collisionGroupID};
        for (let k = 0; k < collisionCircles.length; k += 4) {
            grid.insertCircle(key, collisionCircles[k], collisionCircles[k + 1], collisionCircles[k + 2]);
        }
    }

    projectAnchor(posMatrix: mat4, x: number, y: number) {
        const p = [x, y, 0, 1];
        projection.xyTransformMat4(p, p, posMatrix);
        return {
            perspectiveRatio: 0.5 + 0.5 * (this.transform.cameraToCenterDistance / p[3]),
            cameraDistance: p[3]
        };
    }

    projectPoint(posMatrix: mat4, x: number, y: number) {
        const p = [x, y, 0, 1];
        projection.xyTransformMat4(p, p, posMatrix);
        return new Point(
            (((p[0] / p[3] + 1) / 2) * this.transform.width) + viewportPadding,
            (((-p[1] / p[3] + 1) / 2) * this.transform.height) + viewportPadding
        );
    }

    projectAndGetPerspectiveRatio(posMatrix: mat4, x: number, y: number) {
        const p = [x, y, 0, 1];
        projection.xyTransformMat4(p, p, posMatrix);
        const a = new Point(
            (((p[0] / p[3] + 1) / 2) * this.transform.width) + viewportPadding,
            (((-p[1] / p[3] + 1) / 2) * this.transform.height) + viewportPadding
        );
        return {
            point: a,
            // See perspective ratio comment in symbol_sdf.vertex
            // We're doing collision detection in viewport space so we need
            // to scale down boxes in the distance
            perspectiveRatio: 0.5 + 0.5 * (this.transform.cameraToCenterDistance / p[3])
        };
    }

    isOffscreen(x1: number, y1: number, x2: number, y2: number) {
        return x2 < viewportPadding || x1 >= this.screenRightBoundary || y2 < viewportPadding || y1 > this.screenBottomBoundary;
    }

    isInsideGrid(x1: number, y1: number, x2: number, y2: number) {
        return x2 >= 0 && x1 < this.gridRightBoundary && y2 >= 0 && y1 < this.gridBottomBoundary;
    }
}

function markCollisionCircleUsed(collisionCircles: Array<number>, index: number, used: boolean) {
    collisionCircles[index + 4] = used ? 1 : 0;
}

export default CollisionIndex;
