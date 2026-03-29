# How Stripe's Hero Wave Animations Work

I reverse-engineered the Stripe.com hero canvas animations and reproduced them in React Three Fiber to learn how it was done. I definitely picked up a lot of tricks from looking into this. Some really techincal, others simple but somehow I had never thought to do it that way. Fair warning. If you're not into ThreeJS this probably is not for you. You should have some understanding of GLSL shaders and ThreeJS basics. 

I made my own palette and rewrote the styling and code using React Three Fiber and Tailwind.

Note: This will be ongoing documentation as there is still more to uncover about this hero I bet. And my current findings may have mistakes or a wrong implementation. In fact I'm counting on it. But posting something wrong on the internet is the quickest way to get the right answer. That way we can all learn. 

## TL;DR

- **Same 3D mesh** for both scenes, built off-thread by a Web Worker. It's a flat plane that gets folded into a scroll shape using cosine arcs.
- **Same vertex shader** for both. Animation = simplex noise displacement + triple quaternion twist, all driven by a `u_time` uniform incremented each frame.
- **Different fragment shaders** for the two looks:
  - Dark = `abs(sin(uv.x * 425))` → thousands of thin contour lines, everything else is transparent
  - Light = palette texture + high-frequency noise sparkle → solid iridescent surface with streak highlights
- The 30-odd config parameters in `materialProps` (per theme, per breakpoint) tune position, rotation, scale, twist, and displace to make each breakpoint look right.
- All bitwise noise ops require WebGL 2 (GLSL ES 3.00). This is intentional — GLSL ES 2.00 lacks integer types.

---

## The Shape: One Worker, Two Scenes

There are two ThreeJS animations running of the same mesh object base. The second one is a different line shader and is further down the page. This is only a reproduction of the hero canvas at the top. 
Both the dark "line" hero and the light "surface" hero use same 3D mesh that is created once. Stripe ships a minified Web Worker that builds the geometry off the main thread, then sends the result back as zero-copy transferable `Float32Array`/`Uint32Array` buffers. The mesh starts as a flat 400×400 plane with 128×256 subdivisions, then the worker folds it into the distinctive scroll/ribbon shape you see on the site.

### How the fold works (inside the worker)

Each vertex is processed in a fold function. The plane is divided into three zones along its X axis:

- **Left edge** (`x < -16`): The vertex is pushed outward in Z by a parabola-shaped falloff based on its V coordinate. This creates a curved lip on the left side.
- **Center strip** (`-16 ≤ x ≤ 16`): This is the curved fold area. The vertex traces a cosine arc in XZ — X moves along `cos(t)`, Z moves along `sin(t)`. The result is a smooth 180-degree curve that rolls the left half of the plane back under itself.
- **Right edge** (`x > 16`): The vertex is pushed backward in Z by the same parabola falloff, mirrored. This gives the right side the same curved lip, but flipped.

After the fold, the whole mesh is rotated 90 degrees around X and then 90 degrees around Y using quaternion math. This brings it into the orientation you see on screen — lying roughly flat, viewed slightly from above.

The falloff curve is `4 - 2 * (4 * v * (1 - v))^9.5` — a parabola raised to a high power so it is essentially flat in the middle and spikes sharply at the UV edges. This is what gives the ribbon its characteristic "thinner at the tips, wider in the middle" profile.

waveGeometry.worker.source.ts is the source file that generates the worker. Since I had to reconstruct this from a minified output I cant be sure its exactly right but the minified output matches exactly.

This is the first time I have seen someone offload the mesh creation away from the main thread. I have not done any testing on how efficient this is but hey why not?

---

## The Movement: Vertex Shader (GLSL ES 3.0)

Both scenes share the same vertex shader. The animation happens entirely on the GPU — the geometry itself never changes after the worker builds it.

Three things happen per vertex every frame:

### 1. Displacement (the wave)
```glsl
float noise = simplexNoise(vec2(pos.x * freqX + time, pos.z * freqZ + time));
pos.y += displaceAmount * noise;
```
A 2D simplex noise value is evaluated at a position that drifts with `time` — this is what makes the mesh appear to ripple and breathe. The noise function is notably *not* using a standard GLSL noise library. Stripe implemented their own hash using the `xxhash` algorithm with bit manipulation (`uvec2`, `>>`, `<<`, `^`, `*` on `uint`) — this requires WebGL 2 / GLSL ES 3.00 and is one reason they use `#version 300 es` throughout.

### 2. Twist (the curl)
```glsl
mat4 rotA = rotationMatrix(vec3(0.5, 0.0, 0.5), twistFreqY * expStep(uv.x, twistPowerY));
mat4 rotB = rotationMatrix(vec3(0.0, 0.5, 0.5), twistFreqX * expStep(uv.y, twistPowerX));
mat4 rotC = rotationMatrix(vec3(0.5, 0.0, 0.5), twistFreqZ * expStep(uv.y, twistPowerZ));
```
Each vertex is rotated three times by rotation matrices whose angle is modulated by `expStep` — a falloff function `exp2(-exp2(k) * x^k)`. This means the rotation is strong near the edges of the UV space and fades toward the center. The three twists applied along different axes and UV directions are what produce the asymmetric curl that makes the ribbon look organic.

### 3. Config values control everything
The `materialProps` object in the bundle has around 30 parameters — position, rotation, scale, twist frequencies, twist powers, displace frequency, displace amount, speed, time offset, and color corrections. There are separate configs for dark and light themes, and even separate configs for different breakpoints (desktop, tablet, mobile).

---


### Scene 1: Dark theme — Line/Contour shader
```glsl
float a = abs(sin(v_uv.x * lineAmount));       // sine wave across UVs
a = smoothstep(lineThickness, 0.0, a);          // thin it to a line
color.rgb = mix(clearColor, color.rgb, a * (1.0 - depthFade));
```
The fragment shader draws **nothing but the lines**. It evaluates `abs(sin(uv.x * 425))` — 425 sine cycles across the mesh — then sharpens it into a thin line using `smoothstep`. Everywhere that is not on a line gets mixed back to the background color (black). The derivative `dFdy(uv)` is used to keep line thickness consistent in screen space regardless of perspective. This is purely a contour/wireframe effect rendered as a solid mesh, not actual line primitives.

### Scene 2: Light theme — Surface shader
```glsl
vec3 color = texture(u_paletteTexture, uv).rgb;   // base: palette lookup
float n1 = simplexNoise(vec2(uv.x * (600.0 + 300.0 * n0), uv.y * 4.0 * n0));
color += n1 * 0.2 * (1.0 - color.b * 0.9) * pdy * p;
```
The surface shader samples a **palette texture** (a horizontal gradient strip of iridescent colors) as the base color, then adds a layer of high-frequency simplex noise (`600+` cycles) as a sparkle/streak on top. The noise is not uniform — it is modulated by a lower-frequency noise `n0` first, so the streaks cluster and vary in density. The `pdy` term is a derivative-based glow factor (how fast the UV is changing in Y in screen space), which makes the streaks more visible on the curved parts of the mesh where it's foreshortened.

### The palette texture
Both shaders reference `u_paletteTexture` — a small image that is essentially a 1D gradient of iridescent purples, blues, and greens. Where the UV maps on the mesh maps into this texture determines the base color of each part of the surface. Because the mesh is animated and twisted, different parts drift through different palette positions over time.

---

## Color Post-Processing (both shaders)
After sampling color, both shaders apply the same three corrections:
```glsl
color = contrast(color, u_colorContrast);
color = desaturate(color, 1.0 - u_colorSaturation);
color = hueShift(color, u_colorHueShift);
```
The hue shift uses a vec3 cross-product trick to rotate the color around the `(0.57735, 0.57735, 0.57735)` axis (the neutral gray axis of the color cube) — a more correct hue rotation than the typical HSV approach.

---

## React Three Fiber + React Compiler

Reproducing this in React 19 with the React Compiler enabled added constraints:

- **No mutating refs or useMemo values inside hooks.** The compiler statically analyzes data flow and breaks if you write to a `useMemo`-returned object inside a `useEffect`.
- **Camera frustum sizing** had to move from `useEffect` (which violates the rule) to a `useFrame` callback that only runs when the canvas size actually changes.
- **Uniform updates** happen via `meshRef.current?.material` inside `useFrame` — the material from `useMemo` is passed directly to JSX and never touched again.
- **The geometry worker** is spawned in a `useEffect` with `useState(null)` for the result — the mesh simply renders nothing until the worker responds, then drops in the geometry.

---


