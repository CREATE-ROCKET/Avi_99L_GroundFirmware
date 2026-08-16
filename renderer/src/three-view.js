import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const DEG = Math.PI / 180;
const LAUNCHER_TILT_DEG = 20;
const LAUNCHER_DIRECTION_DEG = 280.66;
const MODEL_FORWARD = new THREE.Vector3(1, 0, 0);

function shortestAngleDelta(a, b) {
  let delta = b - a;
  while (delta > 180) delta -= 360;
  while (delta < -180) delta += 360;
  return delta;
}

function forwardFromTilt(tiltDeg, directionDeg) {
  const tilt = tiltDeg * DEG;
  const direction = directionDeg * DEG;
  return new THREE.Vector3(
    Math.sin(tilt) * Math.sin(direction),
    Math.cos(tilt),
    -Math.sin(tilt) * Math.cos(direction),
  ).normalize();
}

function bodyQuaternion(rollDeg, tiltDeg, directionDeg) {
  const launcherForward = forwardFromTilt(LAUNCHER_TILT_DEG, LAUNCHER_DIRECTION_DEG);
  const currentForward = forwardFromTilt(tiltDeg, directionDeg);
  const qMount = new THREE.Quaternion().setFromUnitVectors(MODEL_FORWARD, launcherForward);
  const qAlign = new THREE.Quaternion().setFromUnitVectors(launcherForward, currentForward);
  const qRoll = new THREE.Quaternion().setFromAxisAngle(currentForward, rollDeg * DEG);
  return qRoll.multiply(qAlign).multiply(qMount).normalize();
}

class PredictivePose {
  constructor() {
    this.mode = 'predictive';
    this.displayQ = new THREE.Quaternion();
    this.initialized = false;
    this.lastSampleHostMs = null;
    this.frozen = false;
    this.displayFin = 0;
  }

  setMode(mode) {
    this.mode = mode;
  }

  sampleAt(samples, nowMs) {
    if (!samples.length) return null;
    const latest = samples[samples.length - 1];
    const ageMs = Math.max(0, nowMs - latest.hostMs);
    const stale = ageMs >= 1000;

    if (stale) {
      this.frozen = true;
      return { q: this.displayQ.clone(), finAngle: this.displayFin, stale, ageMs };
    }
    this.frozen = false;

    if (this.mode === 'hold' || samples.length < 2) {
      const q = bodyQuaternion(latest.roll, latest.tilt, latest.tiltDirection);
      this.displayQ.copy(q);
      this.displayFin = latest.finAngle ?? this.displayFin;
      this.initialized = true;
      return { q, finAngle: this.displayFin, stale: false, ageMs };
    }

    const previous = samples[samples.length - 2];
    const sampleDt = Math.max(0.05, (latest.hostMs - previous.hostMs) / 1000);
    const horizon = Math.min(0.5, ageMs / 1000);
    const tiltRate = (latest.tilt - previous.tilt) / sampleDt;
    const directionRate = shortestAngleDelta(previous.tiltDirection, latest.tiltDirection) / sampleDt;

    const predicted = {
      roll: latest.roll + (latest.rollRate ?? 0) * horizon,
      tilt: THREE.MathUtils.clamp(latest.tilt + tiltRate * horizon, 0, 90),
      direction: latest.tiltDirection + directionRate * horizon,
      fin: (latest.finAngle ?? 0) + (latest.finRate ?? 0) * horizon,
    };
    const targetQ = bodyQuaternion(predicted.roll, predicted.tilt, predicted.direction);

    if (!this.initialized || this.lastSampleHostMs === null) {
      this.displayQ.copy(targetQ);
      this.displayFin = predicted.fin;
      this.initialized = true;
    } else {
      // Causal smoothing: no 500 ms look-ahead. A short exponential correction removes packet-step discontinuity.
      const frameDt = Math.min(0.05, Math.max(0.001, (nowMs - this.lastRenderMs) / 1000));
      const alpha = 1 - Math.exp(-frameDt / 0.085);
      this.displayQ.slerp(targetQ, alpha);
      this.displayFin += (predicted.fin - this.displayFin) * alpha;
    }
    this.lastSampleHostMs = latest.hostMs;
    this.lastRenderMs = nowMs;
    return { q: this.displayQ.clone(), finAngle: this.displayFin, stale: false, ageMs };
  }
}

export class RocketView {
  constructor(host, store, options = {}) {
    this.host = host;
    this.store = store;
    this.statusElement = options.statusElement ?? null;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x10130f);
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.001, 100);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.18;
    this.renderer.shadowMap.enabled = false;
    this.host.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.enablePan = false;
    this.controls.enableZoom = false;
    this.controls.dampingFactor = 0.08;

    this.pose = new PredictivePose();
    this.vehicle = new THREE.Group();
    this.vehicle.name = 'RocketDisplayFrame';
    this.vehicle.visible = false;
    this.scene.add(this.vehicle);
    this.root = null;
    this.finA = null;
    this.finB = null;
    this.finAxes = {
      a: new THREE.Vector3(0, -Math.SQRT1_2, -Math.SQRT1_2),
      b: new THREE.Vector3(0, Math.SQRT1_2, Math.SQRT1_2),
    };
    this.modelCenter = new THREE.Vector3();
    this.modelRadius = 1;
    this.stale = true;

    this.addLighting();
    this.addReference();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(host);
    this.loadModel();
    this.renderer.setAnimationLoop((time) => this.render(time));
  }

  addLighting() {
    // Shadow-free, multi-direction fill lighting. The vehicle stays readable regardless of attitude.
    this.scene.add(new THREE.HemisphereLight(0xf8f7ef, 0x465048, 2.2));
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.25));
    const key = new THREE.DirectionalLight(0xffffff, 2.6);
    key.position.set(4, 6, 5);
    const fill = new THREE.DirectionalLight(0xddeaff, 1.6);
    fill.position.set(-5, 2, 4);
    const rim = new THREE.DirectionalLight(0xffe6cf, 1.25);
    rim.position.set(1, -4, -6);
    [key, fill, rim].forEach((light) => { light.castShadow = false; this.scene.add(light); });
  }

  addReference() {
    const axes = new THREE.AxesHelper(0.32);
    axes.material.transparent = true;
    axes.material.opacity = 0.42;
    this.scene.add(axes);
    const ring = new THREE.RingGeometry(0.46, 0.465, 96);
    const material = new THREE.MeshBasicMaterial({ color: 0x657066, transparent: true, opacity: 0.38, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(ring, material);
    mesh.rotation.x = Math.PI / 2;
    mesh.position.y = -0.42;
    this.scene.add(mesh);
  }

  async loadModel() {
    const url = new URL('../assets/rocket_fin_test.glb', import.meta.url).href;
    new GLTFLoader().load(url, (gltf) => {
      this.root = gltf.scene;
      this.root.name = 'RocketTelemetryRoot';
      this.vehicle.add(this.root);
      this.finA = this.root.getObjectByName('FinA_Pivot');
      this.finB = this.root.getObjectByName('FinB_Pivot');
      if (Array.isArray(this.finA?.userData?.axis)) this.finAxes.a.fromArray(this.finA.userData.axis).normalize();
      if (Array.isArray(this.finB?.userData?.axis)) this.finAxes.b.fromArray(this.finB.userData.axis).normalize();

      this.root.traverse((node) => {
        if (!node.isMesh) return;
        node.castShadow = false;
        node.receiveShadow = false;
        if (node.material?.isMeshStandardMaterial) {
          node.material = node.material.clone();
          node.material.roughness = 0.82;
          node.material.metalness = 0.04;
          node.material.envMapIntensity = 0.35;
          node.material.needsUpdate = true;
        }
      });

      const box = new THREE.Box3().setFromObject(this.root);
      const sphere = box.getBoundingSphere(new THREE.Sphere());
      // Modelをbounding-sphere中心へ平行移動してからdisplay frameを回す。
      // これにより姿勢が変わっても機体中心が画面内に固定される。
      this.root.position.sub(sphere.center);
      this.modelCenter.set(0, 0, 0);
      this.modelRadius = Math.max(sphere.radius, 0.1);
      this.resetObliqueView();
      this.updateStatus('ATTITUDE UNKNOWN');
    }, undefined, (error) => {
      console.error(error);
      this.updateStatus(`MODEL ERROR / ${error.message}`);
    });
  }

  updateStatus(text) {
    if (this.statusElement) this.statusElement.textContent = text;
  }

  setMode(mode) {
    this.pose.setMode(mode);
  }

  resetObliqueView() {
    if (!this.root) return;
    const direction = new THREE.Vector3(1.15, 0.62, 1.0).normalize();
    this.camera.position.copy(this.modelCenter).addScaledVector(direction, this.modelRadius * 4.2);
    this.controls.target.copy(this.modelCenter);
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.modelCenter);
    this.fitFrustum();
    this.controls.update();
  }

  fitFrustum() {
    const aspect = Math.max(0.5, this.host.clientWidth / Math.max(1, this.host.clientHeight));
    const halfHeight = this.modelRadius * 1.34;
    const halfWidth = halfHeight * aspect;
    this.camera.left = -halfWidth;
    this.camera.right = halfWidth;
    this.camera.top = halfHeight;
    this.camera.bottom = -halfHeight;
    this.camera.near = 0.001;
    this.camera.far = this.modelRadius * 20;
    this.camera.zoom = 1;
    this.camera.updateProjectionMatrix();
  }

  resize() {
    const width = Math.max(1, this.host.clientWidth);
    const height = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(width, height, false);
    this.fitFrustum();
  }

  applyFin(angleDeg) {
    if (this.finA) this.finA.quaternion.setFromAxisAngle(this.finAxes.a, angleDeg * DEG);
    if (this.finB) this.finB.quaternion.setFromAxisAngle(this.finAxes.b, angleDeg * DEG);
  }

  render() {
    const now = Date.now();
    if (this.root) {
      const pose = this.pose.sampleAt(this.store.attitudeSamples, now);
      if (pose && !pose.stale) {
        this.vehicle.visible = true;
        this.vehicle.quaternion.copy(pose.q);
        this.applyFin(pose.finAngle ?? 0);
        this.stale = false;
        this.host.classList.remove('is-stale');
        this.updateStatus('LIVE ATTITUDE');
      } else {
        // invalid/stale/no-sampleを最後の正常姿勢で代用しない。
        this.vehicle.visible = false;
        this.stale = true;
        this.host.classList.add('is-stale');
        this.updateStatus(pose?.stale ? `ATTITUDE UNKNOWN / STALE ${(pose.ageMs / 1000).toFixed(1)} s` : 'ATTITUDE UNKNOWN');
      }
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  copyView() {
    const view = {
      schema: 1,
      camera: {
        projection: 'orthographic',
        position: this.camera.position.toArray().map((v) => Number(v.toFixed(8))),
        quaternion: this.camera.quaternion.toArray().map((v) => Number(v.toFixed(8))),
        up: this.camera.up.toArray().map((v) => Number(v.toFixed(8))),
        zoom: this.camera.zoom,
      },
      target: this.controls.target.toArray().map((v) => Number(v.toFixed(8))),
      model: {
        center: this.modelCenter.toArray().map((v) => Number(v.toFixed(8))),
        radius: Number(this.modelRadius.toFixed(8)),
        display_frame_quaternion: this.vehicle.quaternion.toArray().map((v) => Number(v.toFixed(8))),
      },
    };
    return JSON.stringify(view, null, 2);
  }

  dispose() {
    this.renderer.setAnimationLoop(null);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.renderer.dispose();
  }
}
