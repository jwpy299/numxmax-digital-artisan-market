import { useRef } from 'react'
import { Canvas, useFrame } from '@react-three/fiber'
import * as THREE from 'three'

const COUNT = 400

// precomputed once at module scope (stable particle layout, keeps render pure)
const PARTICLES = (() => {
  const positions = new Float32Array(COUNT * 3)
  const colors = new Float32Array(COUNT * 3)
  const cyan = new THREE.Color('#22D3EE')
  const violet = new THREE.Color('#7C5CFF')
  for (let i = 0; i < COUNT; i++) {
    positions[i * 3] = (Math.random() - 0.5) * 10
    positions[i * 3 + 1] = (Math.random() - 0.5) * 6
    positions[i * 3 + 2] = (Math.random() - 0.5) * 4
    const c = Math.random() > 0.5 ? cyan : violet
    const dim = 0.35 + Math.random() * 0.65
    colors[i * 3] = c.r * dim
    colors[i * 3 + 1] = c.g * dim
    colors[i * 3 + 2] = c.b * dim
  }
  return { positions, colors }
})()

function Particles() {
  const groupRef = useRef<THREE.Group>(null)
  const matRef = useRef<THREE.PointsMaterial>(null)
  const opacity = useRef(0)

  useFrame((state, delta) => {
    if (opacity.current < 1 && matRef.current) {
      opacity.current = Math.min(1, opacity.current + delta / 1.5)
      matRef.current.opacity = opacity.current
    }
    const g = groupRef.current
    if (!g) return
    g.rotation.y += delta * 0.01
    const { x, y } = state.pointer
    g.position.x += (x * 0.3 - g.position.x) * 0.04
    g.position.y += (y * 0.22 - g.position.y) * 0.04
  })

  return (
    <group ref={groupRef}>
      <points>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[PARTICLES.positions, 3]} />
          <bufferAttribute attach="attributes-color" args={[PARTICLES.colors, 3]} />
        </bufferGeometry>
        <pointsMaterial
          ref={matRef}
          size={0.028}
          vertexColors
          transparent
          opacity={0}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </points>
    </group>
  )
}

/** 400-particle nebula starfield for the lifecycle hero (lighter than the home hero) */
export default function HeroStarfield() {
  return (
    <Canvas
      camera={{ position: [0, 0, 5], fov: 60 }}
      dpr={[1, 1.5]}
      style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', zIndex: 0 }}
      gl={{ antialias: false, alpha: true }}
    >
      <Particles />
    </Canvas>
  )
}
