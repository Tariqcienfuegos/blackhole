import * as THREE from
"https://cdn.jsdelivr.net/npm/three@0.180.0/build/three.module.js";

/* =====================================================================
   IDEA GENERAL
   Ya no dibujamos una esfera y un anillo. Dibujamos UN rectángulo que
   cubre toda la pantalla y, para cada píxel, un shader lanza un rayo de
   luz hacia atrás desde la cámara. Ese rayo se curva por la gravedad.
   Si cae en el agujero -> negro. Si cruza el disco -> color del disco.
   Si escapa -> estrellas. La curvatura crea el efecto de "lente".
   ===================================================================== */


/* PASO 1: VERTEX SHADER
   Corre una vez por vértice (aquí, las 4 esquinas del rectángulo).
   Solo lo estiramos para cubrir la pantalla y pasamos las coordenadas
   (vUv, de 0 a 1) al fragment shader. */
const vertexShader = /* glsl */`
varying vec2 vUv;
void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;


/* PASO 2: FRAGMENT SHADER
   Corre una vez por CADA píxel, en paralelo en la GPU. Aquí vive el efecto. */
const fragmentShader = /* glsl */`
varying vec2 vUv;
uniform float uTime;        // segundos desde que abrió la página
uniform vec2  uResolution;  // tamaño de la pantalla
uniform vec2  uTilt;        // ángulos de cámara (x = giro, y = altura)
uniform float uDist;        // distancia de la cámara (zoom)

// 2A. Funciones de ruido: números "aleatorios" repetibles.
float hash13(vec3 p) {
    p = fract(p * 0.1031);
    p += dot(p, p.zyx + 31.32);
    return fract((p.x + p.y) * p.z);
}
float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}
float noise(vec2 p) {                       // ruido suave (interpolado)
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), f.x),
               mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p) {                         // suma de 3 capas de ruido = nubes
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 3; i++) { v += a * noise(p); p *= 2.0; a *= 0.5; }
    return v;
}

// 2B. Estrellas: dividimos el cielo en celdas 3D; algunas tienen una estrella.
vec3 starfield(vec3 d) {
    vec3 p = d * 70.0;
    vec3 id = floor(p);
    vec3 f = fract(p) - 0.5;
    float on = step(0.975, hash13(id));                 // ~2.5% de celdas
    float b = smoothstep(0.3, 0.0, length(f)) * on;     // punto suave
    vec3 tint = mix(vec3(0.7, 0.8, 1.0), vec3(1.0, 0.85, 0.7), hash13(id + 3.7));
    return tint * b * (0.5 + hash13(id + 9.1));
}

// 2C. Patrón del disco: 3 brazos espirales + nubes. Gira con la fase 'ph'.
// Lo interno gira más rápido que lo externo (rotación diferencial real).
float patron(vec2 xz, float rr, float ph) {
    float a = ph * 6.0 * pow(rr, -1.5);                  // ángulo girado
    mat2 R = mat2(cos(a), -sin(a), sin(a), cos(a));
    vec2 q = R * xz;
    float ang = atan(q.y, q.x);
    float brazos = 0.5 + 0.5 * sin(3.0 * ang + rr * 1.5); // brazos: hacen visible el giro
    return (0.3 + 1.4 * fbm(q * 1.6)) * (0.5 + 0.9 * brazos);
}

// 2D. Color del disco de acreción en el punto 'hit' donde el rayo lo cruza.
vec3 diskColor(vec3 hit, vec3 vel) {
    float rr = length(hit.xz);                          // distancia al centro
    // El disco existe entre radio 3 y 10, con bordes suaves.
    float edge = smoothstep(3.0, 3.5, rr) * smoothstep(10.0, 7.5, rr);
    if (edge <= 0.0) return vec3(0.0);

    // Mezclamos dos "fases" desfasadas: así el patrón gira sin enrollarse
    // sin fin con el paso del tiempo.
    float T = 5.0;
    float w1 = 1.0 - abs(2.0 * mod(uTime, T) / T - 1.0);
    float pat = mix(patron(hit.xz, rr, mod(uTime + 0.5 * T, T)),
                    patron(hit.xz, rr, mod(uTime, T)), w1);
    float rings = 0.85 + 0.15 * sin(rr * 20.0);         // anillos finos

    // Efecto Doppler: el lado que se acerca a la cámara brilla más.
    vec3 orbit = normalize(vec3(-hit.z, 0.0, hit.x));
    float dop = clamp(1.0 + 1.6 * inversesqrt(rr) * dot(orbit, -vel), 0.15, 2.2);

    // Color según temperatura, como un disco real: lo más cercano al agujero
    // es lo más caliente (blanco amarillento) y se enfría hacia afuera
    // (naranja -> rojo oscuro).
    vec3 c = mix(vec3(1.0, 0.95, 0.8), vec3(1.0, 0.5, 0.1), smoothstep(3.0, 5.0, rr));
    c = mix(c, vec3(0.7, 0.12, 0.02), smoothstep(5.0, 9.0, rr));

    float heat = 1.8 * pow(3.0 / rr, 1.3);              // más brillo adentro
    return c * pat * rings * dop * dop * heat * edge * 0.9;
}

void main() {
    // PASO 3: coordenadas de pantalla centradas en (0,0).
    // La dimensión más corta va de -1 a 1 (así se ve bien en vertical).
    float aspect = uResolution.x / uResolution.y;
    vec2 p = (vUv * 2.0 - 1.0) * vec2(aspect, 1.0) / min(aspect, 1.0);

    // PASO 4: cámara. Órbita a distancia uDist del centro (zoom), mirando al agujero.
    // Unidades: el horizonte del agujero negro tiene radio 1.
    float cy = cos(uTilt.y);
    vec3 ro = uDist * vec3(sin(uTilt.x) * cy, sin(uTilt.y), cos(uTilt.x) * cy);
    vec3 fw = normalize(-ro);                            // hacia adelante
    vec3 rt = normalize(cross(fw, vec3(0.0, 1.0, 0.0))); // derecha
    vec3 up = cross(rt, fw);                             // arriba
    vec3 vel = normalize(fw + 0.65 * (p.x * rt + p.y * up)); // dirección del rayo

    // PASO 5: seguir el rayo paso a paso mientras la gravedad lo curva.
    vec3 pos = ro;
    vec3 hv = cross(pos, vel);
    float h2 = dot(hv, hv);          // constante que mide qué tan "de lado" pasa
    vec3 col = vec3(0.0);
    float minR = 100.0;              // el punto más cercano al centro
    bool captured = false;

    for (int i = 0; i < 220; i++) {
        float r = length(pos);
        minR = min(minR, r);
        if (r < 1.0) { captured = true; break; }   // cayó al horizonte
        if (r > 30.0) break;                       // escapó al espacio

        float dt = clamp(0.05 * r, 0.02, 0.5);     // pasos chicos cerca del centro

        // Gravedad de Schwarzschild: tira del rayo hacia el centro.
        vel = normalize(vel - 1.5 * h2 * pos / (r*r*r*r*r) * dt);
        vec3 np = pos + vel * dt;

        // ¿Cruzó el plano del disco (y = 0)? Entonces suma su color.
        // Como el rayo se curva, puede cruzarlo varias veces: por eso se
        // ve el disco "doblado" por arriba y por debajo del agujero.
        if (pos.y * np.y < 0.0) {
            float t = pos.y / (pos.y - np.y);
            col += diskColor(mix(pos, np, t), vel);
        }
        pos = np;
    }

    // PASO 6: si no cayó, mostramos estrellas (ya deformadas por la lente)
    // y un resplandor donde la luz pasa rozando el agujero.
    if (!captured) {
        col += starfield(vel) * 1.2;
        col += vec3(1.0, 0.55, 0.2) * 0.9 * exp(-max(minR - 2.6, 0.0) * 3.0);
    }

    // PASO 7: ajuste final de color (tone mapping + gamma).
    col = 1.0 - exp(-col * 1.3);
    col = pow(col, vec3(0.4545));
    gl_FragColor = vec4(col, 1.0);
}
`;


/* PASO 8: THREE.JS
   Solo hace de "puente": crea el rectángulo, le pone el shader y
   le envía los datos (uniforms) cada frame. */
const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setPixelRatio(1);   // 1 = rápido. Súbelo (ej. 2) si tu GPU aguanta.
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.domElement.style.touchAction = "none"; // permite arrastrar en móvil
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1); // no importa: el shader ignora esta cámara

// Uniforms: variables que JS le manda al shader.
const uniforms = {
    uTime:       { value: 0 },
    uResolution: { value: new THREE.Vector2(window.innerWidth, window.innerHeight) },
    uTilt:       { value: new THREE.Vector2(0, 1.2) },  // vista casi desde arriba
    uDist:       { value: 13 }
};

const quad = new THREE.Mesh(
    new THREE.PlaneGeometry(2, 2),
    new THREE.ShaderMaterial({ uniforms, vertexShader, fragmentShader })
);
quad.frustumCulled = false;
scene.add(quad);


/* PASO 9: CONTROLES
   - Un dedo / mouse arrastrando: gira la cámara (cambia la forma que ves).
   - Dos dedos (pellizcar) o rueda del mouse: acercar y alejar. */
const clamp = THREE.MathUtils.clamp;
const target = { yaw: 0, pitch: 1.2, dist: 13 };   // valores deseados
const pointers = new Map();                        // dedos que tocan la pantalla
let pinchStart = 1, distStart = 13;

const pinchDist = () => {
    const [a, b] = [...pointers.values()];
    return Math.max(Math.hypot(a.x - b.x, a.y - b.y), 1);
};

window.addEventListener("pointerdown", (e) => {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) { pinchStart = pinchDist(); distStart = target.dist; }
});

window.addEventListener("pointermove", (e) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    if (pointers.size === 1) {
        target.yaw -= (e.clientX - p.x) * 0.005;
        target.pitch = clamp(target.pitch + (e.clientY - p.y) * 0.005, -1.45, 1.45);
        p.x = e.clientX; p.y = e.clientY;
    } else if (pointers.size === 2) {
        p.x = e.clientX; p.y = e.clientY;
        // Dedos separándose -> distancia menor -> te acercas
        target.dist = clamp(distStart * pinchStart / pinchDist(), 5, 24);
    }
});

const soltar = (e) => pointers.delete(e.pointerId);
window.addEventListener("pointerup", soltar);
window.addEventListener("pointercancel", soltar);

window.addEventListener("wheel", (e) => {
    target.dist = clamp(target.dist * (1 + e.deltaY * 0.001), 5, 24);
}, { passive: true });


/* PASO 10: BUCLE DE ANIMACIÓN */
const clock = new THREE.Clock();

function animate() {
    requestAnimationFrame(animate);
    const t = clock.getElapsedTime();
    uniforms.uTime.value = t;

    if (pointers.size === 0) target.yaw += 0.0015;   // gira solo si no lo tocas
    const respiracion = Math.sin(t * 0.5) * 0.06;    // la inclinación "respira": la forma cambia sola

    // Suavizado: todo se acerca poco a poco al valor deseado.
    const tilt = uniforms.uTilt.value;
    tilt.x += (target.yaw - tilt.x) * 0.08;
    tilt.y += (target.pitch + respiracion - tilt.y) * 0.08;
    uniforms.uDist.value += (target.dist - uniforms.uDist.value) * 0.08;

    renderer.render(scene, camera);
}
animate();


/* PASO 11: REDIMENSIONAR */
window.addEventListener("resize", () => {
    renderer.setSize(window.innerWidth, window.innerHeight);
    uniforms.uResolution.value.set(window.innerWidth, window.innerHeight);
});