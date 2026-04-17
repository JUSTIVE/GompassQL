const AMBER = "#f59e0b";
const ROSE = "#e11d48";
const EMERALD = "#10b981";

interface TypeSegment {
  text: string;
  color: string;
}

export function colorizeType(typeStr: string): TypeSegment[] {
  return [{ text: typeStr, color: AMBER }];
}

export function ColoredType({ type, className }: { type: string; className?: string }) {
  return (
    <span className={className}>
      {colorizeType(type).map((seg, i) => (
        <span key={i} style={{ color: seg.color }}>
          {seg.text}
        </span>
      ))}
    </span>
  );
}

export function ColoredTypeSvg({
  type,
  ...props
}: { type: string } & React.SVGTextElementAttributes<SVGTextElement>) {
  return (
    <text {...props}>
      {colorizeType(type).map((seg, i) => (
        <tspan key={i} fill={seg.color}>
          {seg.text}
        </tspan>
      ))}
    </text>
  );
}
