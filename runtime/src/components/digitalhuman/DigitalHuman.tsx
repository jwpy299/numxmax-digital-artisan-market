import { useMemo, useRef } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import * as THREE from 'three'

export interface DigitalHumanPalette {
  primary: string
  accent: string
}

export interface DigitalHumanProps {
  seed: string
  palette?: DigitalHumanPalette
  speaking?: boolean
  size?: number
  className?: string
}

interface AvatarTraits {
  headScale: number
  bodyHeight: number
  bodyRadius: number
  ringRadius: number
  ringTilt: number
  antenna: boolean
  earFins: boolean
  primaryColor: string
  accentColor: string
  phase: number
}

/** Deterministic string hash (FNV-1a 32bit). */
function hashSeed(seed: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

/** Tiny deterministic PRNG (mulberry32) driven by the seed hash. */
function makeRng(seedHash: number): () => number {
  let a = seedHash
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function deriveTraits(seed: string, palette?: DigitalHumanPalette): AvatarTraits {
  const rng = makeRng(hashSeed(seed))
  const pick = (min: number, max: number) => min + rng() * (max - min)
  return {
    headScale: pick(0.85, 1.2),
    bodyHeight: pick(1.0, 1.45),
    bodyRadius: pick(0.34, 0.46),
    ringRadius: pick(0.95, 1.25),
    ringTilt: pick(-0.5, -0.15),
    antenna: rng() > 0.45,
    earFins: rng() > 0.6,
    primaryColor: palette?.primary ?? '#F5A524', // forge-amber
    accentColor: palette?.accent ?? '#22D3EE', // pulse-cyan
    phase: rng() * Math.PI * 2,
  }
}

function Avatar({ seed, palette, speaking }: { seed: string; palette?: DigitalHumanPalette; speaking: boolean }) {
  const traits = useMemo(() => deriveTraits(seed, palette), [seed, palette])

  const rootRef = useRef<THREE.Group>(null)
  const headRef = useRef<THREE.Mesh>(null)
  const coreRef = useRef<THREE.Mesh>(null)
  const coreMatRef = useRef<THREE.MeshStandardMaterial>(null)
  const ringRef = useRef<THREE.Mesh>(null)

  const materials = useMemo(
    () => ({
      body: new THREE.MeshStandardMaterial({
        color: '#1A2233',
        metalness: 0.7,
        roughness: 0.35,
      }),
      head: new THREE.MeshStandardMaterial({
        color: traits.primaryColor,
        emissive: new THREE.Color(traits.primaryColor),
        emissiveIntensity: 0.35,
        metalness: 0.5,
        roughness: 0.3,
        flatShading: true,
      }),
      core: new THREE.MeshStandardMaterial({
        color: traits.accentColor,
        emissive: new THREE.Color(traits.accentColor),
        emissiveIntensity: 1.4,
        metalness: 0.2,
        roughness: 0.2,
      }),
      ring: new THREE.MeshStandardMaterial({
        color: traits.accentColor,
        emissive: new THREE.Color(traits.accentColor),
        emissiveIntensity: 0.9,
        transparent: true,
        opacity: 0.85,
      }),
      eye: new THREE.MeshStandardMaterial({
        color: traits.accentColor,
        emissive: new THREE.Color(traits.accentColor),
        emissiveIntensity: 2.2,
      }),
    }),
    [traits],
  )

  useFrame((state, delta) => {
    const t = state.clock.elapsedTime + traits.phase

    const root = rootRef.current
    if (root) {
      // idle float + slow rotation (refs only, no state churn)
      root.position.y = Math.sin(t * 1.1) * 0.12
      root.rotation.y += delta * 0.35
    }

    const head = headRef.current
    if (head) {
      if (speaking) {
        // speech-rhythm pulse on the head
        const s = 1 + Math.abs(Math.sin(t * 9)) * 0.08 + Math.sin(t * 23) * 0.02
        head.scale.setScalar(traits.headScale * s)
      } else {
        head.scale.setScalar(traits.headScale)
      }
    }

    if (coreMatRef.current) {
      const base = speaking ? 2.6 + Math.abs(Math.sin(t * 9)) * 1.2 : 1.4 + Math.sin(t * 2) * 0.25
      coreMatRef.current.emissiveIntensity = base
    }

    const ring = ringRef.current
    if (ring) {
      ring.rotation.z = traits.ringTilt + Math.sin(t * 0.6) * 0.08
      ring.position.y = -0.15 + Math.sin(t * 1.4 + 1) * 0.06
    }
  })

  const { bodyHeight, bodyRadius, ringRadius, ringTilt } = traits

  return (
    <group ref={rootRef}>
      {/* body: low-poly cylinder */}
      <mesh position={[0, -bodyHeight / 2 + 0.55, 0]} material={materials.body}>
        <cylinderGeometry args={[bodyRadius, bodyRadius * 1.25, bodyHeight, 8]} />
      </mesh>

      {/* glowing core on chest */}
      <mesh ref={coreRef} position={[0, 0.35, bodyRadius * 0.92]}>
        <icosahedronGeometry args={[0.14, 1]} />
        <primitive object={materials.core} attach="material" />
      </mesh>

      {/* head: low-poly sphere */}
      <mesh ref={headRef} position={[0, 0.95, 0]} scale={traits.headScale} material={materials.head}>
        <sphereGeometry args={[0.42, 12, 10]} />
      </mesh>

      {/* eyes */}
      <mesh position={[-0.15, 0.98, 0.36]} material={materials.eye}>
        <sphereGeometry args={[0.05, 8, 8]} />
      </mesh>
      <mesh position={[0.15, 0.98, 0.36]} material={materials.eye}>
        <sphereGeometry args={[0.05, 8, 8]} />
      </mesh>

      {/* antenna (seed-determined) */}
      {traits.antenna && (
        <group position={[0, 0.95 + 0.42 * traits.headScale, 0]}>
          <mesh material={materials.body}>
            <cylinderGeometry args={[0.02, 0.02, 0.3, 6]} />
          </mesh>
          <mesh position={[0, 0.18, 0]} material={materials.eye}>
            <sphereGeometry args={[0.05, 8, 8]} />
          </mesh>
        </group>
      )}

      {/* ear fins (seed-determined) */}
      {traits.earFins && (
        <>
          <mesh position={[-0.46 * traits.headScale, 0.95, 0]} material={materials.ring}>
            <coneGeometry args={[0.09, 0.22, 4]} />
          </mesh>
          <mesh position={[0.46 * traits.headScale, 0.95, 0]} material={materials.ring}>
            <coneGeometry args={[0.09, 0.22, 4]} />
          </mesh>
        </>
      )}

      {/* floating halo ring */}
      <mesh ref={ringRef} rotation={[Math.PI / 2, 0, ringTilt]}>
        <torusGeometry args={[ringRadius, 0.025, 8, 48]} />
        <primitive object={materials.ring} attach="material" />
      </mesh>
    </group>
  )
}

export function DigitalHuman({ seed, palette, speaking = false, size = 320, className }: DigitalHumanProps) {
  return (
    <div className={className} style={{ width: size, height: size }}>
      <Canvas
        dpr={[1, 2]}
        gl={{ antialias: true, alpha: true }}
        frameloop="always"
        camera={{ position: [0, 0, 4], fov: 42 }}
      >
        <ambientLight intensity={0.45} />
        <pointLight position={[3, 4, 4]} intensity={18} color="#F5A524" />
        <pointLight position={[-3, -1, 3]} intensity={8} color="#22D3EE" />
        <Avatar seed={seed} palette={palette} speaking={speaking} />
      </Canvas>
    </div>
  )
}

export default DigitalHuman
