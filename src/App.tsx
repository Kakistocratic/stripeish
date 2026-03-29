'use client';

import { Canvas, useFrame } from '@react-three/fiber';
import { useRef, useEffect, useState, createContext, useContext } from 'react';
import * as THREE from 'three';
import Header from './components/Header';
import ThemeSwitcher from './components/ThemeSwitcher';

// Theme context — shared across both Canvas R3F fiber trees via React context propagation
const ThemeContext = createContext<{ isAlt: boolean; toggle: () => void }>({
  isAlt: false,
  toggle: () => {},
});

const MP = {
  speed:               4e-5,
  timeOffset:          17500,
  colorContrast:       1,
  colorSaturation:     1,
  colorHueShift:       -0.00159265358979299,
  displaceFrequencyX:  0.005831,
  displaceFrequencyZ:  0.016001,
  displaceAmount:      -7.821,
  positionX:           380,
  positionY:           -301.7,
  positionZ:           -11.0999999999999,
  rotationX:           -0.449592653589793,
  rotationY:           -0.117592653589793,
  rotationZ:           1.87440734641021,
  scaleX:              9,
  scaleY:              8,
  scaleZ:              5,
  twistFrequencyX:     -0.649999999999999,
  twistFrequencyY:     0.41,
  twistFrequencyZ:     -0.58,
  twistPowerX:         3.63,
  twistPowerY:         0.7,
  twistPowerZ:         3.95,
  glowRamp:            0.834,
  glowAmount:          1.98,
  glowPower:           0.806,
  lineThickness:       1,
  lineAmount:          1,
  lineDerivativePower: 1,
};

// GPU / device capability detection 
// Mirrors Stripe's F() function from their minified bundle.
// Probes WebGL with failIfMajorPerformanceCaveat, reads the real GPU renderer
// string, normalises it, and runs it through several blocklists before
// assigning a capability tier.  Result is singleton-cached after first call.

// Software / no-GPU renderers that should never run the animation
const GPU_BLOCKLIST = [
  'swiftshader', 'llvmpipe', 'softpipe',
  'microsoft basic render', 'd3d12 (microsoft basic render)',
];
// Apple mobile SoCs too slow for this shader (A10 and earlier)
const APPLE_CHIP_BLOCKLIST = ['a7', 'a8', 'a9', 'a10'];
// Low-end Adreno GPU model numbers
const ADRENO_BLOCKLIST = [200, 205, 220, 225, 300, 302, 304, 305, 306, 308, 320, 330];
// Low-end Mali GPU patterns
const MALI_BLOCKLIST = [
  /mali-?400/i, /mali-?450/i,
  /mali-?t(604|608|622|624|628|720|760)/i,
];

type GPUTier = 'high' | 'medium' | 'low';
interface GPUCapability {
  enabled:    boolean;
  tier:       GPUTier;
  reason:     string;
  renderer:   string;
  vendor:     string | null;
  isMobile:   boolean;
  isIpad:     boolean;
  detectedAt: number;
}

let _gpuCache: GPUCapability | null = null;

function detectGPUCapability(): GPUCapability {
  if (_gpuCache) return _gpuCache;

  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const { userAgent, platform, maxTouchPoints } = window.navigator;
  const isIPhone  = /(iphone|ipod|ipad)/i.test(userAgent);
  const isIpad    = platform === 'iPad' || (platform === 'MacIntel' && maxTouchPoints > 0 && !('MSStream' in window));
  const isMobile  = /android/i.test(userAgent) || isIPhone || isIpad;
  const isSafari12 = /Version\/12.+Safari/.test(userAgent);

  // Probe WebGL — failIfMajorPerformanceCaveat rejects software renderers
  const ctxOpts: WebGLContextAttributes = {
    alpha: false, antialias: false, depth: false,
    failIfMajorPerformanceCaveat: true, stencil: false,
  };
  if (!isSafari12) ctxOpts.powerPreference = 'high-performance';

  const testCanvas = window.document.createElement('canvas');
  const gl = (
    testCanvas.getContext('webgl', ctxOpts) ||
    testCanvas.getContext('experimental-webgl', ctxOpts)
  ) as WebGLRenderingContext | null;

  // Helper: cache and return
  const done = (
    enabled: boolean, tier: GPUTier, reason: string,
    renderer: string, vendor: string | null,
  ): GPUCapability => {
    _gpuCache = { enabled, tier, reason, renderer, vendor, isMobile, isIpad, detectedAt: t0 };
    return _gpuCache;
  };

  if (!gl)
    return done(false, 'high', 'WebGL unavailable or major performance caveat', '', null);

  // Extract the real GPU renderer string
  const ext        = gl.getExtension('WEBGL_debug_renderer_info');
  let rawRenderer  = ext ? (gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) as string ?? '') : '';
  const vendor      = ext ? (gl.getParameter(ext.UNMASKED_VENDOR_WEBGL)   as string ?? null) : null;
  if (!rawRenderer) rawRenderer = gl.getParameter(gl.RENDERER) as string ?? '';

  // Normalise: strip ANGLE wrapper, size suffixes, driver tags
  const renderer = rawRenderer
    .toLowerCase()
    .replace(/.*angle ?\((.+)\)(?: on vulkan [0-9.]+)?$/i, '$1')
    .replace(/\s(\d{1,2}gb|direct3d.+$)|\(r\)| \([^)]+\)$/g, '')
    .replace(/(?:vulkan|opengl) \d+\.\d+(?:\.\d+)?(?: \((.*)\))?/, '$1')
    .replace(/angle metal renderer: apple (m\d+(?:\s+(?:pro|max|ultra))?)/i, 'apple $1');

  // Blocklist checks
  if (GPU_BLOCKLIST.some(b => renderer.includes(b)))
    return done(false, 'high', `Blocklisted GPU: ${renderer}`, renderer, vendor);

  const appleM = renderer.match(/apple (a\d+|m\d+(?:\s+(?:pro|max|ultra))?)/i);
  if (appleM && isMobile && APPLE_CHIP_BLOCKLIST.some(c => appleM[1].toLowerCase().startsWith(c)))
    return done(false, 'high', `Low-end Apple mobile chip: ${renderer}`, renderer, vendor);

  const adrenoM = renderer.match(/adreno[- ]?(\d+)/i);
  if (adrenoM && ADRENO_BLOCKLIST.includes(parseInt(adrenoM[1], 10)))
    return done(false, 'high', `Low-end Adreno GPU: ${renderer}`, renderer, vendor);

  if (MALI_BLOCKLIST.some(rx => rx.test(renderer)))
    return done(false, 'high', `Low-end Mali GPU: ${renderer}`, renderer, vendor);

  if (/powervr\s*(sgx|series\s*[456])/i.test(renderer))
    return done(false, 'high', `Low-end PowerVR GPU: ${renderer}`, renderer, vendor);

  if (/intel.*(gma|g4[15]|q45|hd 3000|hd graphics 3000)/i.test(renderer))
    return done(false, 'high', `Low-end Intel GPU: ${renderer}`, renderer, vendor);

  if (/geforce.*(8\d{3}|9\d{3}|gt\s*[123]\d{2})/i.test(renderer))
    return done(false, 'high', `Low-end NVIDIA GPU: ${renderer}`, renderer, vendor);

  if (/radeon.*(hd\s*[2-5]\d{3})/i.test(renderer))
    return done(false, 'high', `Low-end AMD GPU: ${renderer}`, renderer, vendor);

  // Positive tier assignment
  if (renderer.includes('apple'))
    return done(true, 'high',   `Modern Apple device: ${renderer}`, renderer, vendor);

  if (renderer.includes('nvidia') || renderer.includes('geforce'))
    return done(true, 'medium', `NVIDIA GPU: ${renderer}`, renderer, vendor);

  if (renderer.includes('amd') || renderer.includes('radeon'))
    return done(true, 'medium', `AMD GPU: ${renderer}`, renderer, vendor);

  if (renderer.includes('intel'))
    return done(true, 'low',    `Intel GPU: ${renderer}`, renderer, vendor);

  if (renderer.includes('adreno')) {
    const m = renderer.match(/adreno[- ]?(\d+)/i);
    const n = m ? parseInt(m[1], 10) : 0;
    if (n >= 508)
      return done(true, 'high', `Modern Adreno GPU (${n}): ${renderer}`, renderer, vendor);
  }

  if (renderer.includes('mali')) {
    const m = renderer.match(/mali-?([gt])?(\d+)/i);
    if (m) {
      const type = m[1]?.toLowerCase();
      const n    = parseInt(m[2], 10);
      if (type === 'g' && n >= 57)
        return done(true, 'high', `Modern Mali GPU (G${n}): ${renderer}`, renderer, vendor);
    }
  }

  return done(true, 'low', `Unknown GPU (assumed capable): ${renderer}`, renderer, vendor);
}

function useGPUCapability(): GPUCapability | null {
  // Start null on both server and client (matching SSR output), then populate
  // in useEffect — which only runs after hydration, avoiding the mismatch that
  // occurs when the lazy-initialiser branch `typeof window !== 'undefined'`
  // produces a different value on the client than the server rendered.
  const [cap, setCap] = useState<GPUCapability | null>(null);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCap(detectGPUCapability());
  }, []);
  return cap;
}

// Vertex shader: GLSL3 required (bitwise uint ops)
const VERT = `
uniform float u_time;
uniform float u_speed;
uniform vec2  u_resolution;
uniform float u_twistFrequencyX;
uniform float u_twistFrequencyY;
uniform float u_twistFrequencyZ;
uniform float u_twistPowerX;
uniform float u_twistPowerY;
uniform float u_twistPowerZ;
uniform float u_displaceFrequencyX;
uniform float u_displaceFrequencyZ;
uniform float u_displaceAmount;

out float v_time;
out vec2  v_uv;
out vec3  v_position;
out vec4  v_clipPosition;
out vec2  v_resolution;

float xxhash(vec2 x) {
  uvec2 t = floatBitsToUint(x);
  uint h = 0xc2b2ae3du * t.x + 0x165667b9u;
  h = (h << 17u | h >> 15u) * 0x27d4eb2fu;
  h += 0xc2b2ae3du * t.y;
  h = (h << 17u | h >> 15u) * 0x27d4eb2fu;
  h ^= h >> 15u; h *= 0x85ebca77u;
  h ^= h >> 13u; h *= 0xc2b2ae3du;
  h ^= h >> 16u;
  return uintBitsToFloat(h >> 9u | 0x3f800000u) - 1.0;
}
vec2 hashv(vec2 x) {
  float k = 6.283185307 * xxhash(x);
  return vec2(cos(k), sin(k));
}
float simplexNoise(in vec2 p) {
  const float K1 = 0.366025404;
  const float K2 = 0.211324865;
  vec2 i = floor(p + (p.x + p.y) * K1);
  vec2 a = p - i + (i.x + i.y) * K2;
  float m = step(a.y, a.x);
  vec2 o = vec2(m, 1.0 - m);
  vec2 b = a - o + K2;
  vec2 c = a - 1.0 + 2.0 * K2;
  vec3 h = max(0.5 - vec3(dot(a,a), dot(b,b), dot(c,c)), 0.0);
  vec3 n = h*h*h*vec3(dot(a,hashv(i)), dot(b,hashv(i+o)), dot(c,hashv(i+1.0)));
  return dot(n, vec3(32.99));
}
float expStep(float x, float k) { return exp2(-exp2(k) * pow(x, k)); }
mat4 rotationMatrix(vec3 axis, float angle) {
  axis = normalize(axis);
  float s = sin(angle), c = cos(angle), oc = 1.0 - c;
  return mat4(
    oc*axis.x*axis.x+c,        oc*axis.x*axis.y-axis.z*s, oc*axis.z*axis.x+axis.y*s, 0.0,
    oc*axis.x*axis.y+axis.z*s, oc*axis.y*axis.y+c,        oc*axis.y*axis.z-axis.x*s, 0.0,
    oc*axis.z*axis.x-axis.y*s, oc*axis.y*axis.z+axis.x*s, oc*axis.z*axis.z+c,        0.0,
    0.0, 0.0, 0.0, 1.0
  );
}
vec3 displace(vec2 uv, vec3 pos, float time, float freqX, float freqZ, float amount) {
  float noise = simplexNoise(vec2(pos.x * freqX + time, pos.z * freqZ + time));
  pos.y += amount * noise;
  return pos;
}
void main(void) {
  v_time       = u_time;
  v_uv         = uv;
  v_resolution = u_resolution;
  mat4 rotA = rotationMatrix(vec3(0.5,0.0,0.5), u_twistFrequencyY * expStep(v_uv.x, u_twistPowerY));
  mat4 rotB = rotationMatrix(vec3(0.0,0.5,0.5), u_twistFrequencyX * expStep(v_uv.y, u_twistPowerX));
  mat4 rotC = rotationMatrix(vec3(0.5,0.0,0.5), u_twistFrequencyZ * expStep(v_uv.y, u_twistPowerZ));
  vec3 d = displace(uv, position.xyz, u_time * u_speed,
                    u_displaceFrequencyX, u_displaceFrequencyZ, u_displaceAmount);
  v_position = (vec4(d, 1.0) * rotA).xyz;
  v_position = (vec4(v_position, 1.0) * rotB).xyz;
  v_position = (vec4(v_position, 1.0) * rotC).xyz;
  v_clipPosition = projectionMatrix * modelViewMatrix * vec4(v_position, 1.0);
  gl_Position    = v_clipPosition;
}
`;

// Fragment shader: bundle module 75765 — SURFACE shader, GLSL3
// Solid gradient from palette texture + high-frequency simplex noise sparkle.
// This is the "solid shape with streaks" look, NOT the line-grid shader.
const FRAG = `
in float v_time;
in vec2  v_uv;
in vec3  v_position;
in vec4  v_clipPosition;
in vec2  v_resolution;

out vec4 fragColor;

uniform vec2      u_mousePosition;
uniform sampler2D u_paletteTexture;
uniform float     u_colorSaturation;
uniform float     u_colorContrast;
uniform float     u_colorHueShift;
uniform float     u_glowAmount;
uniform float     u_glowPower;
uniform float     u_glowRamp;
uniform vec3      u_clearColor;

// Shaping 
float mapLinear(float value, float min1, float max1, float min2, float max2) {
  return min2 + (value - min1) * (max2 - min2) / (max1 - min1);
}
float parabola(float x, float k) { return pow(4.0 * x * (1.0 - x), k); }

// Hash / noise (same xxhash-based simplex as vertex shader) 
float xxhash(vec2 x) {
  uvec2 t = floatBitsToUint(x);
  uint h = 0xc2b2ae3du * t.x + 0x165667b9u;
  h = (h << 17u | h >> 15u) * 0x27d4eb2fu;
  h += 0xc2b2ae3du * t.y;
  h = (h << 17u | h >> 15u) * 0x27d4eb2fu;
  h ^= h >> 15u; h *= 0x85ebca77u;
  h ^= h >> 13u; h *= 0xc2b2ae3du;
  h ^= h >> 16u;
  return uintBitsToFloat(h >> 9u | 0x3f800000u) - 1.0;
}
vec2 hashv(vec2 x) {
  float k = 6.283185307 * xxhash(x);
  return vec2(cos(k), sin(k));
}
float simplexNoise(in vec2 p) {
  const float K1 = 0.366025404;
  const float K2 = 0.211324865;
  vec2 i = floor(p + (p.x + p.y) * K1);
  vec2 a = p - i + (i.x + i.y) * K2;
  float m = step(a.y, a.x);
  vec2 o = vec2(m, 1.0 - m);
  vec2 b = a - o + K2;
  vec2 c = a - 1.0 + 2.0 * K2;
  vec3 h = max(0.5 - vec3(dot(a,a), dot(b,b), dot(c,c)), 0.0);
  vec3 n = h*h*h*vec3(dot(a,hashv(i)), dot(b,hashv(i+o)), dot(c,hashv(i+1.0)));
  return dot(n, vec3(32.99));
}

// Color utilities 
vec3 contrast(in vec3 v, in float a) { return (v - 0.5) * a + 0.5; }
vec3 desaturate(vec3 color, float factor) {
  vec3 gray = vec3(dot(vec3(0.299, 0.587, 0.114), color));
  return mix(color, gray, factor);
}
vec3 hueShift(vec3 color, float shift) {
  vec3 gray = vec3(0.57735);
  vec3 proj = gray * dot(gray, color);
  vec3 U = color - proj;
  vec3 V = cross(gray, U);
  return U * cos(shift) + V * sin(shift) + proj;
}
float _rand(in vec2 st) {
  return fract(sin(dot(st.xy, vec2(12.9898, 78.233))) * 43758.5453);
}
vec3 grain(vec3 color, float amount) {
  float gridPos = _rand(gl_FragCoord.xy * 0.01);
  vec3 dither = mix(amount * vec3(4.0/255.0), -amount * vec3(4.0/255.0), gridPos);
  return color + dither;
}

// Surface color: palette sample + noise sparkle
vec3 surfaceColor(vec2 uv, vec3 pos, float pdy) {
  vec3 color = texture(u_paletteTexture, vec2(uv.x, uv.y)).rgb;
  float p  = 1.0 - parabola(uv.x, 3.0);
  float n0 = simplexNoise(vec2(v_uv.x * 0.1,                  v_uv.y * 0.5));
  float n1 = simplexNoise(vec2(v_uv.x * (600.0 + 300.0 * n0), v_uv.y * 4.0 * n0));
  n1 = mapLinear(n1, -1.0, 1.0, 0.0, 1.0);
  color += n1 * 0.2 * (1.0 - color.b * 0.9) * pdy * p;
  return color;
}

void main(void) {
  vec2  dy  = dFdy(v_uv);
  float pdy = dy.y * v_resolution.y * u_glowAmount;
  pdy = mapLinear(pdy, -1.0, 1.0, 0.0, 1.0);
  pdy = clamp(pdy, 0.0, 1.0);
  pdy = pow(pdy, u_glowPower);
  pdy = smoothstep(0.0, u_glowRamp, pdy);
  pdy = clamp(pdy, 0.0, 1.0);

  vec4 color = vec4(surfaceColor(v_uv, v_position, pdy), 1.0);
  color.rgb = contrast(color.rgb,   u_colorContrast);
  color.rgb = desaturate(color.rgb, 1.0 - u_colorSaturation);
  color.rgb = hueShift(color.rgb,   u_colorHueShift);
  color    += (1.0 - pdy) * 0.25;
  color.rgb  = grain(color.rgb, 1.2);
  fragColor  = clamp(color, 0.0, 1.0);
}
`;

//  Wireframe fragment shader — outputs a flat Stripe-periwinkle colour 
// Used with the same VERT so vertex displacement/twist still runs; the surface
// colour logic is stripped entirely.  wireframe:true on the material makes the
// renderer draw only edges, so the mesh structural motion is visible in isolation.
const WIRE_FRAG = `
out vec4 fragColor;
void main() {
  fragColor = vec4(1.0, 1.0, 1.0, 1.0);
}
`;

// Post vertex shader:
// Passes through UVs; places quad at NDC corners via position.
const POST_VERT = `
varying vec2 v_uv;
void main() {
  v_uv = uv;
  gl_Position = vec4(position, 1.0);
}
`;

// Post fragment shader:(hero wave post-processing)
// Reads u_scene (waveTarget). Applies blurAngular (rotational blur, angle=0.02,
// 6 samples ≈ 1.1° total arc) blended by a Y-axis mask, blur is most visible
// at the top/bottom frame edges. Film grain via u_grainAmount.
// u_opaque=0 → output alpha follows scene alpha, so the canvas is transparent
// outside the wave and the white CSS background shows through.
const POST_FRAG = `
varying vec2 v_uv;
uniform sampler2D u_scene;
uniform float     u_blurAmount;
uniform float     u_grainAmount;
uniform float     u_opaque;
uniform vec2      u_resolution;

float _random(in vec2 st) {
  return fract(sin(dot(st.xy, vec2(12.9898, 78.233))) * 43758.5453);
}
vec3 grain(vec3 color, float amount) {
  float g = _random(gl_FragCoord.xy * 0.01);
  vec3  d = vec3(4.0 / 255.0);
  return color + mix(amount * d, -amount * d, g);
}
// Virtual-white blur: colour of each sample is composited over a white
// virtual background before accumulation, so transparent edge pixels
// contribute white to the RGB average (invisible on the white CSS page)
// rather than black (which caused grey fringe).  Alpha is accumulated
// separately as straight alpha so the canvas stays transparent outside
// the mesh — required for the mix-blend-mode text intersection effect.
vec4 blurAngular(sampler2D tex, vec2 uv, float angle) {
  vec4  acc   = vec4(0.0);
  vec2  coord = uv - 0.5;
  float dist  = 1.0 / 6.0;
  vec2  dir   = vec2(cos(angle * dist), sin(angle * dist));
  mat2  rot   = mat2(dir.xy, -dir.y, dir.x);
  for (int i = 0; i < 6; i++) {
    vec4 c = texture2D(tex, coord + 0.5);
    // Composite over virtual white: c.rgb*c.a + 1*(1-c.a)
    vec3 onWhite = c.rgb * c.a + (1.0 - c.a);
    acc += vec4(onWhite, c.a);
    coord *= rot;
  }
  return acc * dist;
}
void main() {
  vec4  raw        = texture2D(u_scene, v_uv);
  // Scene colour also composited over virtual white for consistency
  vec3  sceneOnW   = raw.rgb * raw.a + (1.0 - raw.a);
  vec4  blur       = blurAngular(u_scene, v_uv, u_blurAmount);
  float blurPower  = smoothstep(0.0, 0.7, v_uv.y) - smoothstep(0.2, 1.0, v_uv.y);
  // Mix colours (both on-white) and alphas separately
  vec3  finalRGB   = mix(blur.rgb, sceneOnW, blurPower);
  float finalA     = mix(blur.a,   raw.a,    blurPower);
  finalRGB         = grain(finalRGB, u_grainAmount);
  float alpha      = mix(finalA, 1.0, u_opaque);
  gl_FragColor     = vec4(min(finalRGB, 1.0), alpha);
}
`;

// WaveScene — owns all rendering via priority-1 useFrame 
// Manages an off-R3F ortho wave scene + waveTarget + post-processing pass.
// The R3F default scene is left empty so R3F's auto-render draws nothing over us.
function WaveScene() {
  const { isAlt } = useContext(ThemeContext);
  const timeRef = useRef(MP.timeOffset);
  const bgColorRef = useRef(new THREE.Color('#ffffff'));

  // Sync clear color from CSS variable whenever theme changes
  useEffect(() => {
    const raw = getComputedStyle(document.documentElement)
      .getPropertyValue('--wave-bg')
      .trim();
    if (raw) bgColorRef.current.set(raw);
  }, [isAlt]);

  // off-R3F wave scene + camera 
  const waveSceneRef  = useRef<THREE.Scene>((() => new THREE.Scene())());
  const waveCameraRef = useRef<THREE.OrthographicCamera>((() => {
    const c = new THREE.OrthographicCamera(-400, 400, 300, -300, 1, 20000);
    c.position.set(0, 0, 5000);
    return c;
  })());

  // wave material (useRef+IIFE — React Compiler allows mutations on .current)
  const waveMatRef = useRef<THREE.ShaderMaterial>((() =>
    new THREE.ShaderMaterial({
      glslVersion:    THREE.GLSL3,
      vertexShader:   VERT,
      fragmentShader: FRAG,
      side:           THREE.DoubleSide,
      depthWrite:     true,
      depthTest:      true,
      transparent:    true,
      uniforms: {
        u_time:                { value: MP.timeOffset },
        u_speed:               { value: MP.speed },
        u_resolution:          { value: new THREE.Vector2(1, 1) },
        u_paletteTexture:      { value: null },  // loaded in useEffect
        u_colorContrast:       { value: MP.colorContrast },
        u_colorSaturation:     { value: MP.colorSaturation },
        u_colorHueShift:       { value: MP.colorHueShift },
        u_displaceFrequencyX:  { value: MP.displaceFrequencyX },
        u_displaceFrequencyZ:  { value: MP.displaceFrequencyZ },
        u_displaceAmount:      { value: MP.displaceAmount },
        u_twistFrequencyX:     { value: MP.twistFrequencyX },
        u_twistFrequencyY:     { value: MP.twistFrequencyY },
        u_twistFrequencyZ:     { value: MP.twistFrequencyZ },
        u_twistPowerX:         { value: MP.twistPowerX },
        u_twistPowerY:         { value: MP.twistPowerY },
        u_twistPowerZ:         { value: MP.twistPowerZ },
        u_glowAmount:          { value: MP.glowAmount },
        u_glowPower:           { value: MP.glowPower },
        u_glowRamp:            { value: MP.glowRamp },
        u_lineAmount:          { value: MP.lineAmount },
        u_lineThickness:       { value: MP.lineThickness },
        u_lineDerivativePower: { value: MP.lineDerivativePower },
        u_maxWidth:            { value: 1232 },
        u_clearColor:          { value: new THREE.Vector3(1, 1, 1) },
        u_mousePosition:       { value: new THREE.Vector2(0, 0) },
      },
    })
  )());

  // offscreen render target
  const waveTargetRef = useRef<THREE.WebGLRenderTarget>((() =>
    new THREE.WebGLRenderTarget(512, 512, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format:    THREE.RGBAFormat,
    })
  )());

  // post-processing pass
  const postSceneRef  = useRef<THREE.Scene>((() => new THREE.Scene())());
  const postCameraRef = useRef<THREE.OrthographicCamera>(
    (() => new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1))()
  );
  const postMatRef = useRef<THREE.ShaderMaterial>((() =>
    new THREE.ShaderMaterial({
      vertexShader:   POST_VERT,
      fragmentShader: POST_FRAG,
      uniforms: {
        u_scene:       { value: null },   // connected after target is ready
        u_blurAmount:  { value: 0.02 },   // module 41604 default
        u_grainAmount: { value: 0 },      // FRAG already applies grain; 0 avoids doubling
        u_opaque:      { value: 0 },      // transparent outside wave → CSS white shows through
        u_resolution:  { value: new THREE.Vector2(512, 512) },
      },
      transparent: true,
      depthTest:   false,
      depthWrite:  false,
    })
  )());

  // one-time setup: post mesh and waveTarget connection
  useEffect(() => {
    const waveMat = waveMatRef.current;
    const target  = waveTargetRef.current;
    const postMat = postMatRef.current;

    // Connect waveTarget texture to post shader
    postMat.uniforms.u_scene.value = target.texture;

    // Build fullscreen quad for post pass
    const postGeo  = new THREE.PlaneGeometry(2, 2);
    const postMesh = new THREE.Mesh(postGeo, postMat);
    postSceneRef.current.add(postMesh);

    return () => {
      postGeo.dispose();
      target.dispose();
      waveMat.dispose();
      postMat.dispose();
    };
  }, []);

  // palette load + hot-swap: reacts to isAlt from ThemeContext (crosses Canvas boundary via React context)
  useEffect(() => {
    const waveMat = waveMatRef.current;
    const url = isAlt ? '/palette2.webp' : '/palette1.webp';
    const prev = waveMat.uniforms.u_paletteTexture.value as THREE.Texture | null;
    const tex = new THREE.TextureLoader().load(url);
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    waveMat.uniforms.u_paletteTexture.value = tex;
    prev?.dispose();
    return () => { tex.dispose(); };
  }, [isAlt]);

  // geometry worker
  useEffect(() => {
    const waveScene = waveSceneRef.current;
    const waveMat   = waveMatRef.current;
    const worker = new Worker(
      new URL('./waveGeometry.worker.source.ts', import.meta.url),
      { type: 'module' },
    );
    worker.onmessage = (e: MessageEvent<{
      positions: Float32Array;
      uvs:       Float32Array;
      normals:   Float32Array;
      indices:   Uint32Array;
    }>) => {
      const { positions, uvs, normals, indices } = e.data;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geo.setAttribute('uv',       new THREE.BufferAttribute(uvs, 2));
      geo.setAttribute('normal',   new THREE.BufferAttribute(normals, 3));
      geo.setIndex(new THREE.BufferAttribute(indices, 1));
      const mesh = new THREE.Mesh(geo, waveMat);
      mesh.position.set(MP.positionX, MP.positionY, MP.positionZ);
      mesh.rotation.set(MP.rotationX, MP.rotationY, MP.rotationZ);
      mesh.scale.set(MP.scaleX, MP.scaleY, MP.scaleZ);
      waveScene.add(mesh);
      worker.terminate();
    };
    worker.onerror = (e) => console.error('waveGeometry worker error', e);
    worker.postMessage({ width: 400, height: 400, subdivisionsX: 128, subdivisionsY: 256 });
    return () => {
      worker.terminate();
      // Dispose wave geometry on unmount; material disposal is handled by setup effect
      while (waveScene.children.length) {
        const child = waveScene.children[0] as THREE.Mesh;
        if (child.geometry) child.geometry.dispose();
        waveScene.remove(child);
      }
    };
  }, []);

  // render loop (priority=1: runs before R3F auto-render of empty scene)
  useFrame(({ gl, size }, delta) => {
    const { width, height } = size;

    // Resize wave camera frustum
    const wCam = waveCameraRef.current;
    if (wCam.right !== width / 2) {
      wCam.left   = -width  / 2;
      wCam.right  =  width  / 2;
      wCam.top    =  height / 2;
      wCam.bottom = -height / 2;
      wCam.updateProjectionMatrix();
    }

    // Resize waveTarget if canvas changed
    const target  = waveTargetRef.current;
    const postMat = postMatRef.current;
    if (target.width !== width || target.height !== height) {
      target.setSize(width, height);
      postMat.uniforms.u_resolution.value.set(width, height);
    }

    // Advance time and update wave uniforms
    timeRef.current += delta * 1000;
    const wMat = waveMatRef.current;
    wMat.uniforms.u_time.value = timeRef.current;
    wMat.uniforms.u_resolution.value.set(width, height);

    // Pass 1: wave → waveTarget (transparent-black clear; virtual-white compositing
    // inside the blur shader handles the edge colour, not the clear colour itself)
    gl.setRenderTarget(target);
    gl.setClearColor(0x000000, 0);
    gl.clear();
    gl.render(waveSceneRef.current, waveCameraRef.current);

    // Pass 2: post quad → screen  (alpha:true canvas — transparent outside mesh,
    // so mix-blend-mode on the text layer only fires where the mesh overlaps glyphs)
    gl.setRenderTarget(null);
    gl.setClearColor(0x000000, 0);
    gl.clear();
    gl.render(postSceneRef.current, postCameraRef.current);
  }, 1);

  return null;  // nothing added to R3F default scene; auto-render draws nothing over us
}

// WireframeScene — same geometry worker + vertex shader, no surface colour
// Uses wireframe:true so only mesh edges are drawn.  The vertex shader still runs
// the full displacement + twist logic, so the undulating motion is visible in
// isolation without any palette/sparkle contribution.
function WireframeScene() {
  const { isAlt } = useContext(ThemeContext);
  const timeRef = useRef(MP.timeOffset);
  const bgColorRef = useRef(new THREE.Color('#0a2540'));

  // Sync clear color from CSS variable whenever theme changes
  useEffect(() => {
    const raw = getComputedStyle(document.documentElement)
      .getPropertyValue('--wireframe-bg')
      .trim();
    if (raw) bgColorRef.current.set(raw);
  }, [isAlt]);

  const wireSceneRef  = useRef<THREE.Scene>((() => new THREE.Scene())());
  const wireCameraRef = useRef<THREE.OrthographicCamera>((() => {
    const c = new THREE.OrthographicCamera(-400, 400, 300, -300, 1, 20000);
    c.position.set(0, 0, 5000);
    return c;
  })());

  const wireMatRef = useRef<THREE.ShaderMaterial>((() =>
    new THREE.ShaderMaterial({
      glslVersion:    THREE.GLSL3,
      vertexShader:   VERT,
      fragmentShader: WIRE_FRAG,
      wireframe:      true,
      side:           THREE.DoubleSide,
      transparent:    false,
      uniforms: {
        u_time:               { value: MP.timeOffset },
        u_speed:              { value: MP.speed },
        u_resolution:         { value: new THREE.Vector2(1, 1) },
        u_displaceFrequencyX: { value: MP.displaceFrequencyX },
        u_displaceFrequencyZ: { value: MP.displaceFrequencyZ },
        u_displaceAmount:     { value: MP.displaceAmount },
        u_twistFrequencyX:    { value: MP.twistFrequencyX },
        u_twistFrequencyY:    { value: MP.twistFrequencyY },
        u_twistFrequencyZ:    { value: MP.twistFrequencyZ },
        u_twistPowerX:        { value: MP.twistPowerX },
        u_twistPowerY:        { value: MP.twistPowerY },
        u_twistPowerZ:        { value: MP.twistPowerZ },
      },
    })
  )());

  // geometry worker
  useEffect(() => {
    const wireScene = wireSceneRef.current;
    const wireMat   = wireMatRef.current;
    const worker = new Worker(
      new URL('./waveGeometry.worker.source.ts', import.meta.url),
      { type: 'module' },
    );
    worker.onmessage = (e: MessageEvent<{
      positions: Float32Array;
      uvs:       Float32Array;
      normals:   Float32Array;
      indices:   Uint32Array;
    }>) => {
      const { positions, uvs, normals, indices } = e.data;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      geo.setAttribute('uv',       new THREE.BufferAttribute(uvs, 2));
      geo.setAttribute('normal',   new THREE.BufferAttribute(normals, 3));
      geo.setIndex(new THREE.BufferAttribute(indices, 1));
      const mesh = new THREE.Mesh(geo, wireMat);
      mesh.position.set(MP.positionX, MP.positionY, MP.positionZ);
      mesh.rotation.set(MP.rotationX, MP.rotationY, MP.rotationZ);
      mesh.scale.set(MP.scaleX, MP.scaleY, MP.scaleZ);
      wireScene.add(mesh);
      worker.terminate();
    };
    worker.onerror = (e) => console.error('waveGeometry worker error (wireframe)', e);
    worker.postMessage({ width: 400, height: 400, subdivisionsX: 128, subdivisionsY: 256 });
    return () => {
      worker.terminate();
      while (wireScene.children.length) {
        const child = wireScene.children[0] as THREE.Mesh;
        if (child.geometry) child.geometry.dispose();
        wireScene.remove(child);
      }
    };
  }, []);

  // render loop
  useFrame(({ gl, size }, delta) => {
    const { width, height } = size;

    const wCam = wireCameraRef.current;
    if (wCam.right !== width / 2) {
      wCam.left   = -width  / 2;
      wCam.right  =  width  / 2;
      wCam.top    =  height / 2;
      wCam.bottom = -height / 2;
      wCam.updateProjectionMatrix();
    }

    timeRef.current += delta * 1000;
    const wMat = wireMatRef.current;
    wMat.uniforms.u_time.value = timeRef.current;
    wMat.uniforms.u_resolution.value.set(width, height);

    gl.setRenderTarget(null);
    gl.setClearColor(bgColorRef.current, 1);
    gl.clear();
    gl.render(wireSceneRef.current, wireCameraRef.current);
  }, 1);

  return null;
}

// Page
export default function StripeishHero() {
  const gpu     = useGPUCapability();
  const canDraw = gpu?.enabled ?? false;
  const [isAlt, setIsAlt] = useState(false);
  function toggle() {
    const next = !isAlt;
    setIsAlt(next);
    if (next) document.documentElement.dataset.theme = 'alt';
    else delete document.documentElement.dataset.theme;
  }
  return (
    <ThemeContext.Provider value={{ isAlt, toggle }}>
      <Header />
      <main id="main-content">
        <section className="hero-section-container section" style={{ background: 'var(--wave-bg)' }}>

          {/* ── Text layer: both h1s sit here; canvas background is a sibling below ── */}
          <div className="section-container hero-section__layout z-50">
            <div className="hero-section__layout-grid">

              {/* Background h1 — solid dark text */}
              <h1 className="headingxl hero-section__title hero-section__title--background">
                <em className="hero-section__title-main">I rebuilt the Stripe hero to learn how it's made. </em>
                <span className="hero-section__title-copy">I love ThreeJS and this is a thing of beauty. For a techincal breakdown see my github repo</span>
              </h1>

              {/* Foreground h1 — mix-blend-mode:hard-light, z-index:2 within this stacking context */}
              <h1 className="headingxl hero-section__title hero-section__title--foreground">
                <em className="hero-section__title-main">I rebuilt the Stripe hero to learn how it's made. </em>
                <span className="hero-section__title-copy">I love ThreeJS and this is a thing of beauty. For a techincal breakdown see my github repo</span>
              </h1>

              <div className="actions isolate z-50 flex items-center gap-4">
                <a className="inline-flex items-center gap-2 rounded-md bg-tertiary px-6 py-2.5 text-base text-white transition-colors" href="https://github.com/Kakistocratic/stripeish">
                  Github Repo
                </a>
                <ThemeSwitcher isAlt={isAlt} onToggle={toggle} />
              </div>

            </div>
          </div>

          {/* ── Canvas background layer ── */}
          <div className="section-background hero-section__background" aria-hidden={true}>
            <span className="hero-section__fullbleed-line hero-section__fullbleed-line--top" />
            <span className="hero-section__fullbleed-line" />
            <div className="hero-wave-animation">
              <div className="hero-wave-animation__layout">
                <div className={`hero-wave-animation__contents${canDraw ? ' hero-wave-animation--drawn' : ''}`}>
                  {canDraw && (
                    <Canvas
                      orthographic
                      camera={{ position: [0, 0, 5000], near: 1, far: 10000 }}
                      gl={{ antialias: false, alpha: true }}
                      style={{ pointerEvents: 'none' }}
                      onCreated={({ gl }) => {
                        gl.toneMapping = THREE.NoToneMapping;
                      }}
                      className="hero-wave-animation__canvas"
                    >
                      <WaveScene />
                    </Canvas>
                  )}
                  <div className="hero-wave-animation__static">
                    <picture>
                      <source srcSet="/StripeishHero/fallbacks/wave-fallback-desktop.webp" media="(min-width: 1264px)" type="image/webp" />
                      <source srcSet="/StripeishHero/fallbacks/wave-fallback-tablet.webp" media="(min-width: 640px) and (max-width: 1263px)" type="image/webp" />
                      <source srcSet="/StripeishHero/fallbacks/wave-fallback-mobile.webp" media="(max-width: 639px)" type="image/webp" />
                      <img src="/StripeishHero/fallbacks/wave-fallback-desktop.png" alt="" aria-hidden="true" />
                    </picture>
                  </div>
                </div>
              </div>
            </div>
          </div>

        </section>

        {/* Wireframe breakdown section */}
        <section className="hero-section-container section" style={{ background: 'var(--wireframe-bg)' }}>

          {/* Text layer — use the same container + grid layout as the hero for symmetry */}
          <div className="section-container hero-section__layout">
            <div className="hero-section__layout-grid">
              <div style={{ gridColumn: '2 / -2', position: 'relative', zIndex: 2 }}>
                <h1 className="headingxl hero-section__title hero-section__title--foreground" style={{ color: '#ffffff', mixBlendMode: 'normal' }}>
                  <em className="hero-section__title-main" style={{ color: '#ffffff' }}>Wireframe Mode so we can see the basic shape of the object</em>
                </h1>

                <p className="text-white text-lg md:text-2xl mt-3 md:mt-6 max-w-160 font-(--font-family)">
                  The same geometry and vertex shader run here — displacement and twist uniforms produce the undulating shape. How cool is that! No palette texture, no sparkle noise, no post-processing blur. Just the raw mesh edges.
                  In wireframe mode we can see that there is quite a bit of mesh hidden by the folding of the waves and the position of the camera.
                </p>
              </div>
            </div>
          </div>

          {/* Canvas background layer — mirrors the hero-section__background structure */}
          <div className="section-background" aria-hidden={true}>
            <div className="hero-wave-animation">
              <div className="hero-wave-animation__layout">
                <div className={`hero-wave-animation__contents${canDraw ? ' hero-wave-animation--drawn' : ''}`}>
                  {canDraw && (
                    <Canvas
                      orthographic
                      camera={{ position: [0, 0, 5000], near: 1, far: 10000 }}
                      gl={{ antialias: false, alpha: false }}
                      style={{ pointerEvents: 'none' }}
                      onCreated={({ gl }) => {
                        gl.toneMapping = THREE.NoToneMapping;
                      }}
                      className="hero-wave-animation__canvas"
                    >
                      <WireframeScene />
                    </Canvas>
                  )}
                </div>
              </div>
            </div>
          </div>

        </section>

      </main>
    </ThemeContext.Provider>
  );
}