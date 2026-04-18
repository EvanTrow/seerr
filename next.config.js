/**
 * @type {import('next').NextConfig}
 */
module.exports = {
  env: {
    commitTag: process.env.COMMIT_TAG || 'local',
  },
  images: {
    remotePatterns: [
      { hostname: 'gravatar.com' },
      { hostname: 'image.tmdb.org' },
      { hostname: 'artworks.thetvdb.com' },
      { hostname: 'plex.tv' },
    ],
  },
  webpack(config) {
    config.module.rules.push({
      test: /\.svg$/,
      issuer: /\.(js|ts)x?$/,
      use: ['@svgr/webpack'],
    });

    if (process.env.CYPRESS_COMPONENT_BUILD) {
      config.resolve.alias = {
        ...config.resolve.alias,
        'country-flag-icons/3x2/flags.css': false,
      };
    }

    return config;
  },
  experimental: {
    scrollRestoration: true,
    largePageDataBytes: 512 * 1000,
  },
};
