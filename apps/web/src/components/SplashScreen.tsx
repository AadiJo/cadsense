export function SplashScreen() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="flex items-center justify-center" aria-label="CadSense splash screen">
        <img
          alt="CadSense"
          className="size-16 object-contain"
          src="/apple-touch-icon.png?v=cadsense"
        />
      </div>
    </div>
  );
}
