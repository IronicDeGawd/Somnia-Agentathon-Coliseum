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
  if (!data || data.length < 2) {
    return <svg width={typeof width === 'number' ? width : undefined} height={height} className="sparkline" style={typeof width === 'string' ? { width } : undefined} />;
  }

  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;

  const svgWidth = 200;
  const svgHeight = height;
  const stepX = svgWidth / (data.length - 1);

  const pointStrings = data.map((v, i) => {
    const x = i * stepX;
    const y = svgHeight - 6 - ((v - min) / range) * (svgHeight - 12);
    return `${x},${y}`;
  });

  const linePath = `M ${pointStrings.join(' L ')}`;
  const areaPath = `${linePath} L ${svgWidth},${svgHeight} L 0,${svgHeight} Z`;

  const lastParts = pointStrings[pointStrings.length - 1].split(',');
  const lastX = parseFloat(lastParts[0]);
  const lastY = parseFloat(lastParts[1]);

  const gradId = `sg-${color.replace(/[^a-z0-9]/gi, '')}`;

  return (
    <svg
      width={svgWidth}
      height={svgHeight}
      className="sparkline"
      viewBox={`0 0 ${svgWidth} ${svgHeight}`}
      preserveAspectRatio="none"
      style={typeof width === 'string' ? { width } : { width }}
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.45} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      {fill && <path d={areaPath} fill={`url(#${gradId})`} />}
      <path d={linePath} stroke={color} strokeWidth="1.5" fill="none" />
      <circle cx={lastX} cy={lastY} r="2.5" fill={color} />
    </svg>
  );
};
