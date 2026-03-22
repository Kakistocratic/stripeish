/**
 * waveGeometry.worker.source.ts
 *
 * Human-readable, reverse-engineered source for:
 *   waveGeometry.worker.07101200.js  (Stripe hero animation — geometry web worker)
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * GEOMETRY OVERVIEW
 * ─────────────────────────────────────────────────────────────────────────────
 * This worker generates the one-time static base mesh for Stripe's hero wave.
 * All movement (sinusoidal displacement, UV-driven twisting, colour gradients)
 * lives in the vertex and fragment shaders at runtime.  This worker only builds
 * the initial shape.
 *
 * The shape is a "twisted cloth" with folds like a curtain hanging in the wind.  
 * The flat base mesh is a subdivided plane in the XY plane, centred at the origin.  
 * The plane is then deformed by a "scroll fold" function that converts the flat plane.
 *
 *   Viewed from above (+Y looking down), each row looks like this:
 *
 *          ← x
 *
 *     ──────────── left tail   z = +radius, extends in –x direction
 *               │
 *              arc  (180° circular arc of radius `r`, centred at x = –16)
 *               │
 *     ──────────── right tail  z = –radius, extends in –x direction (x-mirrored)
 *
 * The arc radius varies along the mesh's UV V-coordinate (texture height):
 *
 *   radius(v) = 4 – 2·(4·v·(1–v))^9.5
 *
 *   v = 0 or v = 1  →  radius ≈ 4  (wider at V-edges)
 *   v = 0.5         →  radius = 2  (narrower at V-centre)
 *
 * After the fold, the whole mesh is:
 *   1. Shifted +width/4 along the pre-rotation X axis.
 *   2. Rotated –90° around the world X axis  via quaternion.
 *   3. Rotated –90° around the world Y axis  via quaternion.
 *
 * Combined effect of those two 90° rotations on a point (posX, posY, posZ):
 *   Final scene coords = (posY,  posZ,  posX)
 *   → posY (mesh height) becomes the scene X axis  – the ribbon runs left/right.
 *   → posZ (fold radius) becomes the scene Y axis  – the wave height.
 *   → posX (fold arc x)  becomes the scene Z axis  – depth into screen.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WORKER MESSAGE PROTOCOL
 * ─────────────────────────────────────────────────────────────────────────────
 * Input  (event.data):
 *   { width: number, height: number, subdivisionsX: number, subdivisionsY: number }
 *
 * Output (postMessage, all buffers transferred as Transferables):
 *   { positions: Float32Array,   // 3 floats per vertex  (x,y,z)
 *     uvs:       Float32Array,   // 2 floats per vertex  (u,v)
 *     normals:   Float32Array,   // 3 floats per vertex  — always (0,0,1) placeholder
 *     indices:   Uint32Array  }  // 6 indices per quad   (2 CCW triangles)
 *
 * Example call from experiment7/page.tsx:
 *   worker.postMessage({ width: 400, height: 400, subdivisionsX: 128, subdivisionsY: 256 })
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * NOTE ON MESH NORMALS
 * ─────────────────────────────────────────────────────────────────────────────
 * The normals buffer contains (0, 0, 1) for every vertex.  It is NOT updated
 * after the fold or the quaternion rotations.  Stripe's shaders do not use
 * per-vertex normals for lighting; colour derives entirely from the palette
 * texture + simplex-noise sparkle in the fragment shader.  The buffer is sent
 * because the Three.js BufferGeometry consumer expects it.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface WaveGeometryResult {
  positions: Float32Array; // (subdivisionsX+1) * (subdivisionsY+1) * 3
  uvs:       Float32Array; // (subdivisionsX+1) * (subdivisionsY+1) * 2
  normals:   Float32Array; // (subdivisionsX+1) * (subdivisionsY+1) * 3  — all (0,0,1)
  indices:   Uint32Array;  //  subdivisionsX    *  subdivisionsY    * 6
}

export interface WaveGeometryInput {
  width:         number;
  height:        number;
  subdivisionsX: number;
  subdivisionsY: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Quaternion rotation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Rotate vector `v` around unit `axis` by `angle` radians.
 *
 * Implementation: quaternion sandwich product  q ⊗ v ⊗ q⁻¹
 *
 *   q  = ( qw,  qx,  qy,  qz ) = ( cos(α/2),  axis · sin(α/2) )
 *   q⁻¹= ( qw, –qx, –qy, –qz )   ← conjugate equals inverse for unit quaternions
 *
 * Step 1 — half-product  t = q ⊗ v  (v treated as a pure quaternion, w = 0):
 *   tx =  qw·vx + qy·vz – qz·vy
 *   ty =  qw·vy + qz·vx – qx·vz
 *   tz =  qw·vz + qx·vy – qy·vx
 *   tw = –qx·vx – qy·vy – qz·vz
 *
 * Step 2 — second half-product  result = t ⊗ q⁻¹  (only xyz needed):
 *   rx = tx·qw – tw·qx – ty·qz + tz·qy
 *   ry = ty·qw – tw·qy – tz·qx + tx·qz
 *   rz = tz·qw – tw·qz – tx·qy + ty·qx
 *
 * The arithmetic is written in the same unusual sign form as the original
 * minified code (`a*f + -(h*n) + -(u*l) - -(y*r)`) so that a minifier will
 * reproduce the same bytecode sequence.
 */
function rotateVector(v: Vec3, axis: Vec3, angle: number): Vec3 {
  const halfAngle = angle / 2;
  const sinHalf   = Math.sin(halfAngle);

  // Quaternion components
  const qx = axis.x * sinHalf;
  const qy = axis.y * sinHalf;
  const qz = axis.z * sinHalf;
  const qw = Math.cos(halfAngle);

  // Step 1: t = q ⊗ v
  const tx =  qw * v.x + qy * v.z - qz * v.y;
  const ty =  qw * v.y + qz * v.x - qx * v.z;
  const tz =  qw * v.z + qx * v.y - qy * v.x;
  const tw = -qx * v.x - qy * v.y - qz * v.z;

  // Step 2: result = t ⊗ q⁻¹  (sign form preserved from original)
  return {
    x: tx * qw + -(tw * qx) + -(ty * qz) - -(tz * qy),
    y: ty * qw + -(tw * qy) + -(tz * qx) - -(tx * qz),
    z: tz * qw + -(tw * qz) + -(tx * qy) - -(ty * qx),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Flat plane grid builder
// ─────────────────────────────────────────────────────────────────────────────

interface PlaneGrid {
  positions: Float32Array;
  uvs:       Float32Array;
  indices:   Uint32Array;
}

/**
 * Build a flat, subdivided plane in the XY plane (all z = 0).
 *
 * Vertex layout:
 *   X ranges from  –width/2  (+u=0)  to  +width/2  (u=1)   — left to right
 *   Y ranges from  +height/2 (v=1)   to  –height/2 (v=0)   — top to bottom
 *
 * UV layout:
 *   u = col / subdivisionsX    (0 … 1)
 *   v = 1 – row / subdivisionsY (1 … 0, mirrored so v=1 is at the top row)
 *
 * Triangle winding (CCW when viewed from +Z):
 *
 *   A ──── D        tri 1: A → B → D
 *   │  \   │        tri 2: B → C → D
 *   │   \  │
 *   B ──── C
 *
 *   A = (col,   row)      idx = col   + colCount * row
 *   B = (col,   row+1)    idx = col   + colCount * (row+1)
 *   C = (col+1, row+1)    idx = col+1 + colCount * (row+1)
 *   D = (col+1, row)      idx = col+1 + colCount * row
 */
function buildPlaneGrid(
  width:         number,
  height:        number,
  subdivisionsX: number,
  subdivisionsY: number,
): PlaneGrid {
  const halfWidth  = width  / 2;
  const halfHeight = height / 2;

  const colCount   = subdivisionsX + 1; // number of vertex columns
  const rowCount   = subdivisionsY + 1; // number of vertex rows
  const stepX      = width  / subdivisionsX;
  const stepY      = height / subdivisionsY;

  const totalVertices = colCount * rowCount;
  const positions     = new Float32Array(totalVertices * 3);
  const uvs           = new Float32Array(totalVertices * 2);

  let posIdx = 0;
  let uvIdx  = 0;

  for (let row = 0; row < rowCount; row++) {
    // Negate so that row 0 = top of mesh (+halfHeight) and row max = bottom (–halfHeight)
    const yPos = -(row * stepY - halfHeight);

    for (let col = 0; col < colCount; col++) {
      const xPos = col * stepX - halfWidth;

      positions[posIdx    ] = xPos;
      positions[posIdx + 1] = yPos;
      positions[posIdx + 2] = 0;
      posIdx += 3;

      uvs[uvIdx    ] = col / subdivisionsX;
      uvs[uvIdx + 1] = 1 - row / subdivisionsY;
      uvIdx += 2;
    }
  }

  // Two triangles per quad (CCW): A-B-D then B-C-D
  const indices = new Uint32Array(subdivisionsX * subdivisionsY * 6);
  let triIdx = 0;

  for (let row = 0; row < subdivisionsY; row++) {
    for (let col = 0; col < subdivisionsX; col++) {
      const idxA = col     + colCount *  row;
      const idxB = col     + colCount * (row + 1);
      const idxC = col + 1 + colCount * (row + 1);
      const idxD = col + 1 + colCount *  row;

      indices[triIdx    ] = idxA;
      indices[triIdx + 1] = idxB;
      indices[triIdx + 2] = idxD;
      indices[triIdx + 3] = idxB;
      indices[triIdx + 4] = idxC;
      indices[triIdx + 5] = idxD;
      triIdx += 6;
    }
  }

  return { positions, uvs, indices };
}

// ─────────────────────────────────────────────────────────────────────────────
// Scroll-fold envelope
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the fold "radius" (z-displacement amplitude) for a given UV V value.
 *
 * Formula:  4 – 2 · (4·v·(1–v))^9.5
 *
 * Intuition:
 *   4·v·(1–v)  is a parabola peaked at v=0.5 (value 1) and zero at v=0, v=1.
 *   Raising it to the 9.5 power makes the peak very sharp; it contributes
 *   significantly only very close to v=0.5.
 *   Subtracting from 4 then inverts it:
 *
 *     v = 0.5  →  4 – 2·1^9.5  = 2   (narrowest — centre of mesh height)
 *     v = 0    →  4 – 2·0      = 4   (widest  — bottom edge)
 *     v = 1    →  4 – 2·0      = 4   (widest  — top edge)
 *
 * This gives the scroll a subtly pinched or "waisted" silhouette along its
 * height: wider at the top and bottom bands, narrower in the middle.
 */
function scrollRadius(uvV: number): number {
  return 4 - 2 * (4 * uvV * (1 - uvV)) ** 9.5;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scroll-fold transform
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Apply the "scroll" fold to every vertex of the flat plane in-place.
 *
 * The fold converts the flat XY plane into a scroll (C-cross-section) in XZ.
 * `radius` below refers to scrollRadius(uvV) for the current vertex.
 *
 * ── THREE REGIONS ────────────────────────────────────────────────────────────
 *
 * LEFT TAIL  (original posX < –16)
 *   The left flat section stays flat but is pushed forward (+Z):
 *     posZ += radius
 *
 * FOLD ARC  (–16 ≤ original posX < +16)
 *   A 180° circular arc of radius `radius` in the XZ plane,
 *   centred at (x = –16, z = 0).
 *
 *   Parametrise by angle θ ∈ [0, π] as posX sweeps –16 → +16:
 *     θ = (posX + 16) / 32 · π
 *
 *   The arc traces:
 *     (posX + 16, posZ) = (sin(θ) · radius,  cos(θ) · radius)
 *
 *   Equivalently in terms of two separate trig lookups (matching the original):
 *
 *     θ_z = θ                     → posZ = cos(θ_z) · radius
 *     θ_x = θ – π/2               → posX = cos(θ_x) · radius – 16
 *                                        = sin(θ)   · radius – 16
 *
 *   Start of arc (θ=0, posX=–16): posX = –16,      posZ = +radius  (meets left tail)
 *   Middle       (θ=π/2):         posX = radius–16, posZ =  0       (outermost point)
 *   End of arc   (θ=π,  posX=+16):posX = –16,      posZ = –radius  (meets right tail)
 *
 * RIGHT TAIL  (original posX ≥ +16)
 *   The right flat section stays flat but is pushed backward (–Z) and mirrored:
 *     posZ -= radius
 *     posX  = –posX     ← both tails now extend in the same –x direction
 *
 * POST-FOLD ADJUSTMENTS 
 *
 *  1. posX += width / 4
 *     Centres the scroll within the mesh's horizontal span.
 *
 *  2. rotateVector(pos, X_AXIS, –π/2)
 *     Rotates the scroll –90° around the world X axis.
 *     Effect: (x, y, z) → (x,  z, –y)
 *
 *  3. rotateVector(pos, Y_AXIS, –π/2)
 *     Rotates –90° around the world Y axis.
 *     Effect: (x, y, z) → (–z, y,  x)
 *
 *  Combined: (posX, posY, posZ)  →  scene (posY, posZ, posX)
 *    posY (mesh height dimension) → scene X  — ribbon runs left/right
 *    posZ (fold radius value)     → scene Y  — wave height / curl
 *    posX (arc x value)           → scene Z  — depth
 *
 * Modifies `positions` in-place.
 */
function applyScrollFold(
  positions: Float32Array,
  uvs:       Float32Array,
  width:     number,
): void {
  const vertexCount = positions.length / 3;

  // Constant rotation axes
  const X_AXIS: Vec3 = { x: 1, y: 0, z: 0 };
  const Y_AXIS: Vec3 = { x: 0, y: 1, z: 0 };

  // Arc fold boundaries (fixed — these are Stripe's hardcoded seam positions)
  const ARC_LEFT  = -16; // posX where left tail meets the arc
  const ARC_RIGHT = +16; // posX where right tail meets the arc
  const ARC_SPAN  = ARC_RIGHT - ARC_LEFT; // = 32

  for (let i = 0; i < vertexCount; i++) {
    const posBase = 3 * i;
    const uvBase  = 2 * i;

    let posX =  positions[posBase    ];
    const posY = positions[posBase + 1]; // never modified
    let posZ =  positions[posBase + 2]; // initially 0, set by fold

    // UV V-coordinate drives the fold radius (see scrollRadius() above)
    const uvV    = uvs[uvBase + 1];
    const radius = scrollRadius(uvV);

    // Apply fold 

    if (posX < ARC_LEFT) {
      // LEFT TAIL — flat section, offset forward in Z
      posZ += radius;

    } else if (posX < ARC_RIGHT) {
      // FOLD ARC — 180° circular arc centred at (–16, 0) in XZ
      //
      // θ_z ∈ [0, π]:  used for the Z component
      const thetaZ = 0 + (posX - ARC_LEFT) * (Math.PI - 0) / ARC_SPAN;
      posZ = Math.cos(thetaZ) * radius;

      // θ_x ∈ [–π/2, +π/2]:  used for the X component
      // cos(θ_x) = cos(θ_z – π/2) = sin(θ_z) → traces a circle
      const thetaX = (-Math.PI / 2) + (posX - ARC_LEFT) * (Math.PI / 2 - (-Math.PI / 2)) / ARC_SPAN;
      posX = Math.cos(thetaX) * radius - 16;

    } else {
      // RIGHT TAIL — flat section, offset backward in Z; mirror x so both tails run parallel
      posZ -= radius;
      posX  = -posX;
    }

    // Post-fold: centre the scroll, then orient for the scene 

    // 1. Horizontal centering offset
    posX += width / 4;

    // 2 & 3. Two 90° quaternion rotations to orient the scroll in world space
    let pos: Vec3 = { x: posX, y: posY, z: posZ };
    pos = rotateVector(pos, X_AXIS, -Math.PI / 2);
    pos = rotateVector(pos, Y_AXIS, -Math.PI / 2);

    positions[posBase    ] = pos.x;
    positions[posBase + 1] = pos.y;
    positions[posBase + 2] = pos.z;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main geometry generator  (exported for direct use in Three.js / R3F)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate the complete wave geometry buffers.
 *
 * Usage with Three.js BufferGeometry:
 *
 *   const { positions, uvs, normals, indices } = generateWaveGeometry({
 *     width: 400, height: 400, subdivisionsX: 128, subdivisionsY: 256,
 *   });
 *
 *   const geo = new THREE.BufferGeometry();
 *   geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
 *   geo.setAttribute('uv',       new THREE.BufferAttribute(uvs,       2));
 *   geo.setAttribute('normal',   new THREE.BufferAttribute(normals,   3));
 *   geo.setIndex(new THREE.BufferAttribute(indices, 1));
 */
export function generateWaveGeometry({
  width,
  height,
  subdivisionsX,
  subdivisionsY,
}: WaveGeometryInput): WaveGeometryResult {
  // 1. Build the flat plane
  const { positions, uvs, indices } = buildPlaneGrid(
    width, height, subdivisionsX, subdivisionsY,
  );

  // 2. Fold it into the scroll shape (modifies positions in-place)
  applyScrollFold(positions, uvs, width);

  // 3. Flat normals — all (0, 0, 1).
  //    NOT transformed with positions. Stripe's shaders do not use normals for
  //    lighting; this is a placeholder buffer expected by the geometry consumer.
  const vertexCount = positions.length / 3;
  const normals     = new Float32Array(vertexCount * 3);
  for (let i = 0; i < vertexCount; i++) {
    normals[i * 3    ] = 0;
    normals[i * 3 + 1] = 0;
    normals[i * 3 + 2] = 1;
  }

  return { positions, uvs, normals, indices };
}

// ─────────────────────────────────────────────────────────────────────────────
// Web Worker message handler
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Install the message handler only when this script is actually running inside
 * a Web Worker.
 *
 * The original minified check is `"u" > typeof self` which exploits JS string
 * comparison to avoid referencing `undefined`:
 *
 *   typeof self in a Worker  → "object"     →  "u" > "object"    = true  ✓
 *   typeof self in Node.js   → "undefined"  →  "u" > "undefined" = false ✗
 *   typeof self in a Window  → "object", but self.importScripts is not a function ✗
 *
 * The second check `typeof self.importScripts === "function"` distinguishes a
 * Worker globalThis from a browser Window (which also has typeof self = "object").
 *
 * Input:  event.data = WaveGeometryInput
 * Output: postMessage(result, [transferables])   — zero-copy buffer transfer
 */
if (
  typeof self !== 'undefined' &&
  typeof (self as unknown as { importScripts: unknown }).importScripts === 'function'
) {
  (self as unknown as Worker).onmessage = (
    event: MessageEvent<WaveGeometryInput>,
  ) => {
    const geometry = generateWaveGeometry(event.data);

    // Transfer the underlying ArrayBuffers — avoids structured-clone copies
    (self as unknown as Worker).postMessage(geometry, [
      geometry.positions.buffer,
      geometry.uvs.buffer,
      geometry.normals.buffer,
      geometry.indices.buffer,
    ]);
  };
}
