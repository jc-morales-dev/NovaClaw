import React, { useMemo } from 'react';
import { motion } from 'motion/react';

interface NovaCircleProps {
  className?: string;
}

export default function NovaCircle({ className = "w-[0.75em] h-[0.75em]" }: NovaCircleProps) {
  const particles = useMemo(() => {
    return Array.from({ length: 150 }).map(() => {
      // Create a 3D sphere distribution projection for the "O"
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(Math.random() * 2 - 1);
      const radius = 48; // slightly less than 50% to stay inside bounds
      
      const x = 50 + radius * Math.sin(phi) * Math.cos(theta);
      const y = 50 + radius * Math.sin(phi) * Math.sin(theta);
      const z = radius * Math.cos(phi); // determines opacity/shadow

      return {
        x: `${x}%`,
        y: `${y}%`,
        size: Math.random() * 2.5 + 0.5,
        opacity: z > 0 ? (Math.random() * 0.7 + 0.3) : (Math.random() * 0.2 + 0.05),
      };
    });
  }, []);

  return (
    <div className={`relative flex items-center justify-center ${className}`}>
      <motion.div
        animate={{ rotate: 360 }}
        transition={{ duration: 45, repeat: Infinity, ease: "linear" }}
        className="absolute inset-0 rounded-full"
      >
        {particles.map((p, i) => (
          <div
            key={i}
            className="absolute bg-white rounded-full"
            style={{
              left: p.x,
              top: p.y,
              width: `${p.size}px`,
              height: `${p.size}px`,
              opacity: p.opacity,
              boxShadow: p.size > 1.5 && p.opacity > 0.5 ? `0 0 ${p.size * 2}px rgba(255,255,255,0.9)` : 'none'
            }}
          />
        ))}
      </motion.div>
      {/* Shadows to provide 3D depth to the sphere */}
      <div className="absolute inset-0 rounded-full shadow-[inset_-6px_-6px_12px_rgba(0,0,0,0.9)]" />
      <div className="absolute inset-0 rounded-full shadow-[inset_6px_6px_12px_rgba(255,255,255,0.1)]" />
    </div>
  );
}
