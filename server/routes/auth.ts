import JellyfinAPI, { type JellyfinUserResponse } from '@server/api/jellyfin';
import PlexTvAPI from '@server/api/plextv';
import { ApiErrorCode } from '@server/constants/error';
import { MediaServerType, ServerType } from '@server/constants/server';
import { UserType } from '@server/constants/user';
import { getRepository } from '@server/datasource';
import { User } from '@server/entity/User';
import { startJobs } from '@server/job/schedule';
import { Permission } from '@server/lib/permissions';
import { getSettings } from '@server/lib/settings';
import logger from '@server/logger';
import { isAuthenticated } from '@server/middleware/auth';
import { checkAvatarChanged } from '@server/routes/avatarproxy';
import { ApiError } from '@server/types/error';
import { getAppVersion } from '@server/utils/appVersion';
import { getHostname } from '@server/utils/getHostname';
import axios from 'axios';
import { Router, type Request } from 'express';
import net from 'net';
import validator from 'validator';

const authRoutes = Router();

authRoutes.get('/me', isAuthenticated(), async (req, res) => {
  const userRepository = getRepository(User);
  if (!req.user) {
    return res.status(500).json({
      status: 500,
      error: 'Please sign in.',
    });
  }
  const user = await userRepository.findOneOrFail({
    where: { id: req.user.id },
  });

  // check if email is required in settings and if user has an valid email
  const settings = await getSettings();
  if (
    settings.notifications.agents.email.options.userEmailRequired &&
    !validator.isEmail(user.email, { require_tld: false })
  ) {
    user.warnings.push('userEmailRequired');
    logger.warn(`User ${user.username} has no valid email address`);
  }

  return res.status(200).json(user);
});

authRoutes.post('/plex', async (req, res, next) => {
  const settings = getSettings();
  const userRepository = getRepository(User);
  const body = req.body as { authToken?: string };

  if (!body.authToken) {
    return next({
      status: 500,
      message: 'Authentication token required.',
    });
  }

  if (
    settings.main.mediaServerType != MediaServerType.NOT_CONFIGURED &&
    (settings.main.mediaServerLogin === false ||
      settings.main.mediaServerType != MediaServerType.PLEX)
  ) {
    return res.status(500).json({ error: 'Plex login is disabled' });
  }
  try {
    // First we need to use this auth token to get the user's email from plex.tv
    const plextv = new PlexTvAPI(body.authToken);
    const account = await plextv.getUser();

    // Next let's see if the user already exists
    let user = await userRepository
      .createQueryBuilder('user')
      .where('user.plexId = :id', { id: account.id })
      .orWhere('user.email = :email', {
        email: account.email.toLowerCase(),
      })
      .getOne();

    if (!user && !(await userRepository.count())) {
      user = new User({
        email: account.email,
        plexUsername: account.username,
        plexId: account.id,
        plexToken: account.authToken,
        permissions: Permission.ADMIN,
        avatar: account.thumb,
        userType: UserType.PLEX,
      });

      settings.main.mediaServerType = MediaServerType.PLEX;
      await settings.save();
      startJobs();

      await userRepository.save(user);
    } else {
      const mainUser = await userRepository.findOneOrFail({
        select: { id: true, plexToken: true, plexId: true, email: true },
        where: { id: 1 },
      });
      const mainPlexTv = new PlexTvAPI(mainUser.plexToken ?? '');

      if (!account.id) {
        logger.error('Plex ID was missing from Plex.tv response', {
          label: 'API',
          ip: req.ip,
          email: account.email,
          plexUsername: account.username,
        });

        return next({
          status: 500,
          message: 'Something went wrong. Try again.',
        });
      }

      if (
        account.id === mainUser.plexId ||
        (account.email === mainUser.email && !mainUser.plexId) ||
        (await mainPlexTv.checkUserAccess(account.id))
      ) {
        if (user) {
          if (!user.plexId) {
            logger.info(
              'Found matching Plex user; updating user with Plex data',
              {
                label: 'API',
                ip: req.ip,
                email: user.email,
                userId: user.id,
                plexId: account.id,
                plexUsername: account.username,
              }
            );
          }

          user.plexToken = body.authToken;
          user.plexId = account.id;
          user.avatar = account.thumb;
          user.email = account.email;
          user.plexUsername = account.username;
          user.userType = UserType.PLEX;

          await userRepository.save(user);
        } else if (!settings.main.newPlexLogin) {
          logger.warn(
            'Failed sign-in attempt by unimported Plex user with access to the media server',
            {
              label: 'API',
              ip: req.ip,
              email: account.email,
              plexId: account.id,
              plexUsername: account.username,
            }
          );
          return next({
            status: 403,
            message: 'Access denied.',
          });
        } else {
          logger.info(
            'Sign-in attempt from Plex user with access to the media server; creating new Seerr user',
            {
              label: 'API',
              ip: req.ip,
              email: account.email,
              plexId: account.id,
              plexUsername: account.username,
            }
          );
          user = new User({
            email: account.email,
            plexUsername: account.username,
            plexId: account.id,
            plexToken: account.authToken,
            permissions: settings.main.defaultPermissions,
            avatar: account.thumb,
            userType: UserType.PLEX,
          });

          await userRepository.save(user);
        }
      } else {
        logger.warn(
          'Failed sign-in attempt by Plex user without access to the media server',
          {
            label: 'API',
            ip: req.ip,
            email: account.email,
            plexId: account.id,
            plexUsername: account.username,
          }
        );
        return next({
          status: 403,
          message: 'Access denied.',
        });
      }
    }

    // Set logged in session
    if (req.session) {
      req.session.userId = user.id;
    }

    return res.status(200).json(user?.filter() ?? {});
  } catch (e) {
    logger.error('Something went wrong authenticating with Plex account', {
      label: 'API',
      errorMessage: e.message,
      ip: req.ip,
    });
    return next({
      status: 500,
      message: 'Unable to authenticate.',
    });
  }
});

const DISCORD_PLUGIN_GUID = '359a7d2a-1c54-4e70-abbb-01bc73f098cf';

interface DiscordPluginUser {
  Id: string;
  Username: string;
  Global_name?: string;
  Email?: string;
}

interface DiscordPluginConfig {
  clientId: string;
  clientSecret: string;
  serverUrl: string;
  botToken: string;
  serverId: string;
  discordUserData: Record<string, DiscordPluginUser>;
}

async function getDiscordPluginConfig(
  apiKey: string
): Promise<DiscordPluginConfig> {
  const url = `${getHostname()}/Plugins/${DISCORD_PLUGIN_GUID}/Configuration`;
  const response = await axios.get<Record<string, unknown>>(url, {
    headers: {
      'X-Emby-Authorization': `MediaBrowser Client="Seerr", Device="Seerr", DeviceId="seerr", Version="1.0", Token="${apiKey}"`,
    },
  });
  const data = response.data;
  return {
    clientId: (data.ClientId as string) ?? '',
    clientSecret: (data.ClientSecret as string) ?? '',
    serverUrl: (data.ServerUrl as string) ?? '',
    botToken: (data.BotToken as string) ?? '',
    serverId: (data.ServerId as string) ?? '',
    discordUserData:
      (data.DiscordUserData as Record<string, DiscordPluginUser>) ?? {},
  };
}

async function getDiscordDisplayName(
  botToken: string,
  guildId: string,
  userId: string,
  discordUser: { username: string; global_name?: string }
): Promise<string> {
  if (botToken && guildId) {
    try {
      const res = await fetch(
        `https://discord.com/api/v10/guilds/${guildId}/members/${userId}`,
        { headers: { Authorization: `Bot ${botToken}` } }
      );
      if (res.ok) {
        const member = await res.json();
        if (member.nick) return member.nick;
      }
    } catch {
      // non-fatal — fall through to defaults
    }
  }
  return discordUser.global_name ?? discordUser.username;
}

function getDiscordAvatarUrl(
  userId: string,
  avatarHash: string | null
): string {
  if (avatarHash) {
    const ext = avatarHash.startsWith('a_') ? 'gif' : 'png';
    return `https://cdn.discordapp.com/avatars/${userId}/${avatarHash}.${ext}?size=256`;
  }
  return `https://cdn.discordapp.com/embed/avatars/${Number(BigInt(userId) % 6n)}.png`;
}

function getSeerrBaseUrl(
  settings: ReturnType<typeof getSettings>,
  req: Request
) {
  return (
    settings.main.applicationUrl?.replace(/\/$/, '') ||
    `${req.protocol}://${req.get('host')}`
  );
}

function getUserAvatarUrl(user: User): string {
  return `/avatarproxy/${user.jellyfinUserId}?v=${user.avatarVersion}`;
}

authRoutes.post('/jellyfin', async (req, res, next) => {
  const settings = getSettings();
  const userRepository = getRepository(User);
  const body = req.body as {
    username?: string;
    password?: string;
    hostname?: string;
    port?: number;
    urlBase?: string;
    useSsl?: boolean;
    email?: string;
    serverType?: number;
  };

  //Make sure jellyfin login is enabled, but only if jellyfin && Emby is not already configured
  if (
    // media server not configured, allow login for setup
    settings.main.mediaServerType != MediaServerType.NOT_CONFIGURED &&
    (settings.main.mediaServerLogin === false ||
      // media server is neither jellyfin or emby
      (settings.main.mediaServerType !== MediaServerType.JELLYFIN &&
        settings.main.mediaServerType !== MediaServerType.EMBY))
  ) {
    return res.status(500).json({ error: 'Jellyfin login is disabled' });
  }

  if (!body.username) {
    return res.status(500).json({ error: 'You must provide an username' });
  } else if (settings.jellyfin.ip !== '' && body.hostname) {
    return res
      .status(500)
      .json({ error: 'Jellyfin hostname already configured' });
  } else if (settings.jellyfin.ip === '' && !body.hostname) {
    return res.status(500).json({ error: 'No hostname provided.' });
  }

  try {
    const hostname =
      settings.jellyfin.ip !== ''
        ? getHostname()
        : getHostname({
            useSsl: body.useSsl,
            ip: body.hostname,
            port: body.port,
            urlBase: body.urlBase,
          });

    // Try to find deviceId that corresponds to jellyfin user, else generate a new one
    let user = await userRepository.findOne({
      where: { jellyfinUsername: body.username },
      select: { id: true, jellyfinDeviceId: true },
    });

    let deviceId = 'BOT_seerr';
    if (user && user.id === 1) {
      // Admin is always BOT_seerr
      deviceId = 'BOT_seerr';
    } else if (user && user.jellyfinDeviceId) {
      deviceId = user.jellyfinDeviceId;
    } else if (body.username) {
      deviceId = Buffer.from(`BOT_seerr_${body.username}`).toString('base64');
    }

    // First we need to attempt to log the user in to jellyfin
    const jellyfinserver = new JellyfinAPI(hostname ?? '', undefined, deviceId);

    const ip = req.ip;
    let clientIp;

    if (ip) {
      if (net.isIPv4(ip)) {
        clientIp = ip;
      } else if (net.isIPv6(ip)) {
        clientIp = ip.startsWith('::ffff:') ? ip.substring(7) : ip;
      }
    }

    const account = await jellyfinserver.login(
      body.username,
      body.password,
      clientIp
    );

    // Next let's see if the user already exists
    user = await userRepository.findOne({
      where: { jellyfinUserId: account.User.Id },
    });

    const missingAdminUser = !user && !(await userRepository.count());
    if (
      missingAdminUser ||
      settings.main.mediaServerType === MediaServerType.NOT_CONFIGURED
    ) {
      // Check if user is admin on jellyfin
      if (account.User.Policy.IsAdministrator === false) {
        throw new ApiError(403, ApiErrorCode.NotAdmin);
      }

      if (
        body.serverType !== MediaServerType.JELLYFIN &&
        body.serverType !== MediaServerType.EMBY
      ) {
        throw new ApiError(500, ApiErrorCode.NoAdminUser);
      }
      settings.main.mediaServerType = body.serverType;

      if (missingAdminUser) {
        logger.info(
          'Sign-in attempt from Jellyfin user with access to the media server; creating initial admin user for Seerr',
          {
            label: 'API',
            ip: req.ip,
            jellyfinUsername: account.User.Name,
          }
        );

        // User doesn't exist, and there are no users in the database, we'll create the user
        // with admin permissions

        user = new User({
          id: 1,
          email: body.email || account.User.Name,
          jellyfinUsername: account.User.Name,
          jellyfinUserId: account.User.Id,
          jellyfinDeviceId: deviceId,
          jellyfinAuthToken: account.AccessToken,
          permissions: Permission.ADMIN,
          userType:
            body.serverType === MediaServerType.JELLYFIN
              ? UserType.JELLYFIN
              : UserType.EMBY,
        });
        user.avatar = getUserAvatarUrl(user);

        await userRepository.save(user);
      } else {
        logger.info(
          'Sign-in attempt from Jellyfin user with access to the media server; editing admin user for Seerr',
          {
            label: 'API',
            ip: req.ip,
            jellyfinUsername: account.User.Name,
          }
        );

        // User alread exist but settings.json is not configured, we'll edit the admin user

        user = await userRepository.findOne({
          where: { id: 1 },
        });
        if (!user) {
          throw new Error('Unable to find admin user to edit');
        }
        user.email = body.email || account.User.Name;
        user.jellyfinUsername = account.User.Name;
        user.jellyfinUserId = account.User.Id;
        user.jellyfinDeviceId = deviceId;
        user.jellyfinAuthToken = account.AccessToken;
        user.permissions = Permission.ADMIN;
        user.avatar = getUserAvatarUrl(user);
        user.userType =
          body.serverType === MediaServerType.JELLYFIN
            ? UserType.JELLYFIN
            : UserType.EMBY;

        await userRepository.save(user);
      }

      // Create an API key on Jellyfin from this admin user
      const jellyfinClient = new JellyfinAPI(
        hostname,
        account.AccessToken,
        deviceId
      );
      const apiKey = await jellyfinClient.createApiToken('Seerr');

      const serverName = await jellyfinserver.getServerName();

      settings.jellyfin.name = serverName;
      settings.jellyfin.serverId = account.User.ServerId;
      settings.jellyfin.ip = body.hostname ?? '';
      settings.jellyfin.port = body.port ?? 8096;
      settings.jellyfin.urlBase = body.urlBase ?? '';
      settings.jellyfin.useSsl = body.useSsl ?? false;
      settings.jellyfin.apiKey = apiKey;
      await settings.save();
      startJobs();
    }
    // User already exists, let's update their information
    else if (account.User.Id === user?.jellyfinUserId) {
      logger.info(
        `Found matching ${
          settings.main.mediaServerType === MediaServerType.JELLYFIN
            ? ServerType.JELLYFIN
            : ServerType.EMBY
        } user; updating user with ${
          settings.main.mediaServerType === MediaServerType.JELLYFIN
            ? ServerType.JELLYFIN
            : ServerType.EMBY
        }`,
        {
          label: 'API',
          ip: req.ip,
          jellyfinUsername: account.User.Name,
        }
      );
      user.avatar = getUserAvatarUrl(user);
      user.jellyfinUsername = account.User.Name;

      if (user.username === account.User.Name) {
        user.username = '';
      }

      await userRepository.save(user);
    } else if (!settings.main.newPlexLogin) {
      logger.warn(
        'Failed sign-in attempt by unimported Jellyfin user with access to the media server',
        {
          label: 'API',
          ip: req.ip,
          jellyfinUserId: account.User.Id,
          jellyfinUsername: account.User.Name,
        }
      );
      return next({
        status: 403,
        message: 'Access denied.',
      });
    } else if (!user) {
      logger.info(
        'Sign-in attempt from Jellyfin user with access to the media server; creating new Seerr user',
        {
          label: 'API',
          ip: req.ip,
          jellyfinUsername: account.User.Name,
        }
      );

      user = new User({
        email: body.email,
        jellyfinUsername: account.User.Name,
        jellyfinUserId: account.User.Id,
        jellyfinDeviceId: deviceId,
        permissions: settings.main.defaultPermissions,
        userType:
          settings.main.mediaServerType === MediaServerType.JELLYFIN
            ? UserType.JELLYFIN
            : UserType.EMBY,
      });
      user.avatar = getUserAvatarUrl(user);

      //initialize Jellyfin/Emby users with local login
      const passedExplicitPassword = body.password && body.password.length > 0;
      if (passedExplicitPassword) {
        await user.setPassword(body.password ?? '');
      }
      await userRepository.save(user);
    }

    if (user && user.jellyfinUserId) {
      try {
        const { changed } = await checkAvatarChanged(user);

        if (changed) {
          user.avatar = getUserAvatarUrl(user);
          await userRepository.save(user);
          logger.debug('Avatar updated during login', {
            userId: user.id,
            jellyfinUserId: user.jellyfinUserId,
          });
        }
      } catch (error) {
        logger.error('Error handling avatar during login', {
          label: 'Auth',
          errorMessage: error.message,
        });
      }
    }

    // Set logged in session
    if (req.session) {
      req.session.userId = user?.id;
    }

    return res.status(200).json(user?.filter() ?? {});
  } catch (e) {
    switch (e.errorCode) {
      case ApiErrorCode.InvalidUrl:
        logger.error(
          `The provided ${
            settings.main.mediaServerType === MediaServerType.JELLYFIN
              ? ServerType.JELLYFIN
              : ServerType.EMBY
          } is invalid or the server is not reachable.`,
          {
            label: 'Auth',
            error: e.errorCode,
            status: e.statusCode,
            hostname: getHostname({
              useSsl: body.useSsl,
              ip: body.hostname,
              port: body.port,
              urlBase: body.urlBase,
            }),
          }
        );
        return next({
          status: e.statusCode,
          message: e.errorCode,
        });

      case ApiErrorCode.InvalidCredentials:
        logger.warn(
          'Failed sign-in attempt from user with incorrect Jellyfin credentials',
          {
            label: 'Auth',
            account: {
              ip: req.ip,
              email: body.username,
              password: '__REDACTED__',
            },
          }
        );
        return next({
          status: e.statusCode,
          message: e.errorCode,
        });

      case ApiErrorCode.NotAdmin:
        logger.warn(
          'Failed sign-in attempt from user without admin permissions',
          {
            label: 'Auth',
            account: {
              ip: req.ip,
              email: body.username,
            },
          }
        );
        return next({
          status: e.statusCode,
          message: e.errorCode,
        });

      case ApiErrorCode.NoAdminUser:
        logger.warn(
          'Failed sign-in attempt from user without admin permissions and no admin user exists',
          {
            label: 'Auth',
            account: {
              ip: req.ip,
              email: body.username,
            },
          }
        );
        return next({
          status: e.statusCode,
          message: e.errorCode,
        });

      default:
        logger.error(e.message, { label: 'Auth' });
        return next({
          status: 500,
          message: 'Something went wrong.',
        });
    }
  }
});

authRoutes.get('/discord/login', async (req, res, next) => {
  const settings = getSettings();

  if (
    settings.main.mediaServerType !== MediaServerType.NOT_CONFIGURED &&
    (settings.main.mediaServerLogin === false ||
      settings.jellyfin.enableDiscordAuth === false ||
      (settings.main.mediaServerType !== MediaServerType.JELLYFIN &&
        settings.main.mediaServerType !== MediaServerType.EMBY))
  ) {
    return res.status(403).json({ error: 'Discord sign-in is disabled.' });
  }

  try {
    const pluginConfig = await getDiscordPluginConfig(settings.jellyfin.apiKey);

    if (!pluginConfig.clientId) {
      return next({
        status: 500,
        message:
          'Discord plugin is not configured on the Jellyfin server. Set a Client ID in the plugin settings.',
      });
    }

    const redirectUri = `${getSeerrBaseUrl(settings, req)}/login`;
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: pluginConfig.clientId,
      scope: 'identify email',
      redirect_uri: redirectUri,
      state: 'discord',
      prompt: 'consent',
    });

    return res.redirect(`https://discord.com/oauth2/authorize?${params}`);
  } catch (e) {
    logger.error('Failed to fetch Discord plugin configuration from Jellyfin', {
      label: 'Auth',
      errorMessage: e.message,
    });
    return next({
      status: 500,
      message: 'Failed to retrieve Discord configuration from Jellyfin.',
    });
  }
});

authRoutes.post('/discord', async (req, res, next) => {
  const settings = getSettings();
  const userRepository = getRepository(User);
  const body = req.body as { code?: string };

  if (
    settings.main.mediaServerType !== MediaServerType.NOT_CONFIGURED &&
    (settings.main.mediaServerLogin === false ||
      settings.jellyfin.enableDiscordAuth === false ||
      (settings.main.mediaServerType !== MediaServerType.JELLYFIN &&
        settings.main.mediaServerType !== MediaServerType.EMBY))
  ) {
    return res.status(403).json({ error: 'Discord sign-in is disabled.' });
  }

  if (!body.code) {
    return next({ status: 400, message: 'Authorization code required.' });
  }

  try {
    const pluginConfig = await getDiscordPluginConfig(settings.jellyfin.apiKey);

    if (!pluginConfig.clientId || !pluginConfig.clientSecret) {
      return next({
        status: 500,
        message:
          'Discord plugin is not configured on the Jellyfin server. Set Client ID and Client Secret in the plugin settings.',
      });
    }

    const redirectUri = `${getSeerrBaseUrl(settings, req)}/login`;

    const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: pluginConfig.clientId,
        client_secret: pluginConfig.clientSecret,
        grant_type: 'authorization_code',
        code: body.code,
        redirect_uri: redirectUri,
      }),
    });

    if (!tokenResponse.ok) {
      logger.error('Failed to fetch Discord OAuth2 token', {
        label: 'Auth',
        status: tokenResponse.status,
        statusText: tokenResponse.statusText,
        ip: req.ip,
      });
      return next({
        status: 500,
        message: 'Unable to authenticate with Discord.',
      });
    }

    const tokenData = await tokenResponse.json();
    const accessToken = tokenData.access_token;

    const discordUserResponse = await fetch(
      'https://discord.com/api/v10/users/@me',
      {
        headers: { Authorization: `Bearer ${accessToken}` },
      }
    );

    if (!discordUserResponse.ok) {
      logger.error('Failed to fetch Discord user profile', {
        label: 'Auth',
        status: discordUserResponse.status,
        ip: req.ip,
      });
      return next({
        status: 500,
        message: 'Unable to authenticate with Discord.',
      });
    }

    const discordUser = await discordUserResponse.json();
    const discordId: string = discordUser.id;

    logger.debug(
      'Discord OAuth successful, looking up Jellyfin user via plugin map',
      {
        label: 'Auth',
        discordId,
        discordUsername: discordUser.username,
        ip: req.ip,
      }
    );

    // Find the Jellyfin user ID mapped to this Discord user in the plugin
    const jellyfinUserId = Object.entries(pluginConfig.discordUserData).find(
      ([, du]) => du.Id === discordId
    )?.[0];

    if (!jellyfinUserId) {
      logger.warn(
        'Failed Discord sign-in: Discord account not linked to any Jellyfin user',
        {
          label: 'Auth',
          discordId,
          ip: req.ip,
        }
      );
      return next({ status: 403, message: 'Access denied.' });
    }

    // Fetch the specific Jellyfin user to verify they are not disabled
    const jellyfinClient = new JellyfinAPI(
      getHostname(),
      settings.jellyfin.apiKey,
      'BOT_seerr'
    );
    jellyfinClient.setUserId(jellyfinUserId);

    let jellyfinUser: JellyfinUserResponse;
    try {
      jellyfinUser = await jellyfinClient.getUser();
    } catch {
      logger.warn('Failed Discord sign-in: could not fetch Jellyfin user', {
        label: 'Auth',
        jellyfinUserId,
        discordId,
        ip: req.ip,
      });
      return next({ status: 403, message: 'Access denied.' });
    }

    if (jellyfinUser.Policy.IsDisabled) {
      logger.warn('Failed Discord sign-in: Jellyfin user is disabled', {
        label: 'Auth',
        jellyfinUserId,
        jellyfinUsername: jellyfinUser.Name,
        ip: req.ip,
      });
      return next({ status: 403, message: 'Access denied.' });
    }

    let user = await userRepository.findOne({
      where: { jellyfinUserId: jellyfinUser.Id },
    });

    if (!user) {
      if (!settings.main.newPlexLogin) {
        logger.warn('Failed Discord sign-in: unimported Jellyfin user', {
          label: 'Auth',
          ip: req.ip,
          jellyfinUserId: jellyfinUser.Id,
          jellyfinUsername: jellyfinUser.Name,
        });
        return next({ status: 403, message: 'Access denied.' });
      }

      logger.info(
        'Discord sign-in: creating new Seerr user for Jellyfin user',
        {
          label: 'Auth',
          ip: req.ip,
          jellyfinUsername: jellyfinUser.Name,
        }
      );

      const deviceId = Buffer.from(`BOT_seerr_${jellyfinUser.Name}`).toString(
        'base64'
      );

      user = new User({
        email: discordUser.email ?? jellyfinUser.Name,
        jellyfinUsername: jellyfinUser.Name,
        jellyfinUserId: jellyfinUser.Id,
        jellyfinDeviceId: deviceId,
        permissions: jellyfinUser.Policy.IsAdministrator
          ? Permission.ADMIN
          : settings.main.defaultPermissions,
        userType:
          settings.main.mediaServerType === MediaServerType.JELLYFIN
            ? UserType.JELLYFIN
            : UserType.EMBY,
      });

      await user.setPassword(
        [...Array(32)].map(() => Math.random().toString(36)[2]).join('')
      );
      await userRepository.save(user);
    } else if (
      jellyfinUser.Policy.IsAdministrator &&
      !user.hasPermission(Permission.ADMIN)
    ) {
      user.permissions = Permission.ADMIN;
    }

    // Sync display name and avatar from Discord on every login
    const displayName = await getDiscordDisplayName(
      pluginConfig.botToken,
      pluginConfig.serverId,
      discordId,
      discordUser
    );
    const avatarUrl = getDiscordAvatarUrl(
      discordId,
      discordUser.avatar ?? null
    );

    user.username = displayName;
    user.avatar = avatarUrl;
    await userRepository.save(user);

    if (req.session) {
      req.session.userId = user.id;
    }

    return res.status(200).json(user.filter() ?? {});
  } catch (e) {
    logger.error('Something went wrong authenticating with Discord', {
      label: 'Auth',
      errorMessage: e.message,
      ip: req.ip,
    });
    return next({
      status: 500,
      message: 'Unable to authenticate with Discord.',
    });
  }
});

authRoutes.post('/local', async (req, res, next) => {
  const settings = getSettings();
  const userRepository = getRepository(User);
  const body = req.body as { email?: string; password?: string };

  if (!settings.main.localLogin) {
    return res.status(500).json({ error: 'Password sign-in is disabled.' });
  } else if (!body.email || !body.password) {
    return res.status(500).json({
      error: 'You must provide both an email address and a password.',
    });
  }
  try {
    const user = await userRepository
      .createQueryBuilder('user')
      .select(['user.id', 'user.email', 'user.password', 'user.plexId'])
      .where('user.email = :email', { email: body.email.toLowerCase() })
      .getOne();

    if (!user || !(await user.passwordMatch(body.password))) {
      logger.warn('Failed sign-in attempt using invalid Seerr password', {
        label: 'API',
        ip: req.ip,
        email: body.email,
        userId: user?.id,
      });
      return next({
        status: 403,
        message: 'Access denied.',
      });
    }

    // Set logged in session
    if (user && req.session) {
      req.session.userId = user.id;
    }

    return res.status(200).json(user?.filter() ?? {});
  } catch (e) {
    logger.error('Something went wrong authenticating with Seerr password', {
      label: 'API',
      errorMessage: e.message,
      ip: req.ip,
      email: body.email,
    });
    return next({
      status: 500,
      message: 'Unable to authenticate.',
    });
  }
});

authRoutes.post('/logout', async (req, res, next) => {
  try {
    const userId = req.session?.userId;
    if (!userId) {
      return res.status(200).json({ status: 'ok' });
    }

    const settings = getSettings();
    const isJellyfinOrEmby =
      settings.main.mediaServerType === MediaServerType.JELLYFIN ||
      settings.main.mediaServerType === MediaServerType.EMBY;

    if (isJellyfinOrEmby) {
      const user = await getRepository(User)
        .createQueryBuilder('user')
        .addSelect(['user.jellyfinUserId', 'user.jellyfinDeviceId'])
        .where('user.id = :id', { id: userId })
        .getOne();

      if (user?.jellyfinUserId && user.jellyfinDeviceId) {
        try {
          const baseUrl = getHostname();
          try {
            await axios.delete(`${baseUrl}/Devices`, {
              params: { Id: user.jellyfinDeviceId },
              headers: {
                'X-Emby-Authorization': `MediaBrowser Client="Seerr", Device="Seerr", DeviceId="seerr", Version="${
                  settings.main.mediaServerType === MediaServerType.EMBY
                    ? '1.0.0'
                    : getAppVersion()
                }", Token="${settings.jellyfin.apiKey}"`,
              },
            });
          } catch (error) {
            logger.error('Failed to delete Jellyfin device', {
              label: 'Auth',
              error: error instanceof Error ? error.message : 'Unknown error',
              userId: user.id,
              jellyfinUserId: user.jellyfinUserId,
            });
          }
        } catch (error) {
          logger.error('Failed to delete Jellyfin device', {
            label: 'Auth',
            error: error instanceof Error ? error.message : 'Unknown error',
            userId: user.id,
            jellyfinUserId: user.jellyfinUserId,
          });
        }
      }
    }

    req.session?.destroy((err: Error | null) => {
      if (err) {
        logger.error('Failed to destroy session', {
          label: 'Auth',
          error: err.message,
          userId,
        });
        return next({ status: 500, message: 'Failed to destroy session.' });
      }
      logger.debug('Successfully logged out user', {
        label: 'Auth',
        userId,
      });
      res.status(200).json({ status: 'ok' });
    });
  } catch (error) {
    logger.error('Error during logout process', {
      label: 'Auth',
      error: error instanceof Error ? error.message : 'Unknown error',
      userId: req.session?.userId,
    });
    next({ status: 500, message: 'Error during logout process.' });
  }
});

authRoutes.post('/reset-password', async (req, res, next) => {
  const userRepository = getRepository(User);
  const body = req.body as { email?: string };

  if (!body.email) {
    return next({
      status: 500,
      message: 'Email address required.',
    });
  }

  const user = await userRepository
    .createQueryBuilder('user')
    .where('user.email = :email', { email: body.email.toLowerCase() })
    .getOne();

  if (user) {
    await user.resetPassword();
    await userRepository.save(user);
    logger.info('Successfully sent password reset link', {
      label: 'API',
      ip: req.ip,
      email: body.email,
    });
  } else {
    logger.error('Something went wrong sending password reset link', {
      label: 'API',
      ip: req.ip,
      email: body.email,
    });
  }

  return res.status(200).json({ status: 'ok' });
});

authRoutes.post('/reset-password/:guid', async (req, res, next) => {
  const userRepository = getRepository(User);

  if (!req.body.password || req.body.password?.length < 8) {
    logger.warn('Failed password reset attempt using invalid new password', {
      label: 'API',
      ip: req.ip,
      guid: req.params.guid,
    });
    return next({
      status: 500,
      message: 'Password must be at least 8 characters long.',
    });
  }

  const user = await userRepository.findOne({
    where: { resetPasswordGuid: req.params.guid },
  });

  if (!user) {
    logger.warn('Failed password reset attempt using invalid recovery link', {
      label: 'API',
      ip: req.ip,
      guid: req.params.guid,
    });
    return next({
      status: 500,
      message: 'Invalid password reset link.',
    });
  }

  if (
    !user.recoveryLinkExpirationDate ||
    user.recoveryLinkExpirationDate <= new Date()
  ) {
    logger.warn('Failed password reset attempt using expired recovery link', {
      label: 'API',
      ip: req.ip,
      guid: req.params.guid,
      email: user.email,
    });
    return next({
      status: 500,
      message: 'Invalid password reset link.',
    });
  }
  user.recoveryLinkExpirationDate = null;
  await user.setPassword(req.body.password);
  await userRepository.save(user);
  logger.info('Successfully reset password', {
    label: 'API',
    ip: req.ip,
    guid: req.params.guid,
    email: user.email,
  });

  return res.status(200).json({ status: 'ok' });
});

export default authRoutes;
