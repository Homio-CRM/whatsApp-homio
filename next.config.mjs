/** @type {import('next').NextConfig} */
const nextConfig = {
  eslint: {
    ignoreDuringBuilds: true,
  },
  typescript: {
    ignoreBuildErrors: true,
  },
  images: {
    unoptimized: true,
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          // Remove X-Frame-Options so browsers fall back to CSP frame-ancestors
          {
            key: "X-Frame-Options",
            value: "",
          },
          // Allow embedding from any origin (required for GHL iframe)
          {
            key: "Content-Security-Policy",
            value: "frame-ancestors *",
          },
        ],
      },
    ]
  },
}

export default nextConfig