import React from 'react';

interface ProgressBarProps {
  progress: number;
  label?: string;
  color?: string;
  showPercentage?: boolean;
}

export default function ProgressBar({
  progress,
  label,
  color = 'bg-gradient-to-r from-indigo-500 to-purple-500',
  showPercentage = false,
}: ProgressBarProps) {
  const clampedProgress = Math.min(100, Math.max(0, progress));

  return (
    <div className="w-full" role="progressbar" aria-valuenow={clampedProgress} aria-valuemin={0} aria-valuemax={100}>
      {label && (
        <div className="flex justify-between items-center mb-1">
          <span className="text-sm text-slate-300">{label}</span>
          {showPercentage && (
            <span className="text-sm text-slate-400">{Math.round(clampedProgress)}%</span>
          )}
        </div>
      )}
      <div className="h-2 bg-slate-700 rounded-full overflow-hidden">
        <div
          className={`h-full ${color} transition-all duration-500 ease-out rounded-full`}
          style={{ width: `${clampedProgress}%` }}
        />
      </div>
    </div>
  );
}
