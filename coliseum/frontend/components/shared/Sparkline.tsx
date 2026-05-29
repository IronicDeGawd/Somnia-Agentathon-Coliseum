'use client';

import React from 'react';

interface SparklineProps {
  data: number[];
  width?: string | number;
  height?: number;
  color?: string;
  fill?: boolean;
}

export const Sparkline: React.FC<SparklineProps> = ({
  data,
  width = '100%',
  height = 40,
  color = 'var(--fighter-a)',
  fill = true,
}) => {
  if (!data || data.length === 0) return null;

  const points = data.length === 1 ? [data[0], data[0]] : data;
  const max = Math.max(...points, 1);
  const min = Math.min(...points, -1);
  const range = max - min === 0 ? 1 : max - min;

  // Compute SVG coordinates
  const svgWidth = 100;
  const svgHeight = height;
  
  const pointsCoords = points.map((val, idx) => {
    const x = (idx / (points.length - 1)) * svgWidth;
    // Invert Y coordinate so higher values are at the top
    const y = svgHeight - 4 - ((val - min) / range) * (svgHeight - 8);
    return { x, y };
  });

  const pathD = pointsCoords.reduce((acc, pt, idx) => {
    return acc + `${idx === 0 ? 'M' : 'L'} ${pt.x.toFixed(1)} ${pt.y.toFixed(1)}`;
  }, '');

  const areaD = pathD
    ? `${pathD} L ${svgWidth} ${svgHeight} L 0 ${svgHeight} Z`
    : '';

  const endPoint = pointsCoords[pointsCoords.length - 1];

  // Unique ID for the area gradient fill
  const gradId = React.useId().replace(/[^a-zA-Z0-9]/g, '');

  return (
    <div style={{ width, height }} className="relative">
      <svg
        viewBox={`0 0 ${svgWidth} ${svgHeight}`}
        className="w-full h-full overflow-visible"
        preserveAspectRatio="none"
      >
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.25} />
            <stop offset="100%" stopColor={color} stopOpacity={0.0} />
          </linearGradient>
        </defs>

        {/* Gradient Area Fill */}
        {fill && areaD && (
          <path d={areaD} fill={`url(#${gradId})`} className="transition-all duration-300" />
        )}

        {/* Stroke Line */}
        {pathD && (
          <path
            d={pathD}
            fill="none"
            stroke={color}
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="transition-all duration-300"
          />
        )}

        {/* Endpoint node */}
        {endPoint && (
          <circle
            cx={endPoint.x}
            cy={endPoint.y}
            r="2"
            fill={color}
            className="animate-ping origin-center"
            style={{ transformOrigin: `${endPoint.x}px ${endPoint.y}px` }}
          />
        )}
        {endPoint && (
          <rect
            x={endPoint.x - 1}
            y={endPoint.y - 1}
            width="2"
            height="2"
            fill={color}
          />
        )}
      </svg>
    </div>
  );
};
