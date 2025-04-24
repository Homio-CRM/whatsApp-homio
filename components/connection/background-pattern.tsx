interface BackgroundPatternProps {
  imagePath: string
}

export function BackgroundPattern({ imagePath }: BackgroundPatternProps) {
  return (
    <div
      className="fixed inset-0 pointer-events-none z-[-1]"
      style={{
        backgroundImage: `url('${imagePath}')`,
        backgroundSize: "cover",
        backgroundPosition: "center",
        backgroundRepeat: "no-repeat",
        width: "100%",
        height: "100%",
      }}
    />
  )
}
