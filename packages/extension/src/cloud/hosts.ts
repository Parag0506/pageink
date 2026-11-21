/**
 * Every address the cloud code may reach. These are the only remote addresses in the
 * product (PRIVACY.md). The no-network test pins each one to this file's bundle, and the
 * manifest's connect-src allows only their hosts.
 */

export interface GoogleHosts {
  /** The sign-in page. Opened in the browser's sign-in window, never fetched. */
  auth: string;
  revoke: string;
  api: string;
  upload: string;
}

export interface MicrosoftHosts {
  /** The sign-in page. Opened in the browser's sign-in window, never fetched. */
  auth: string;
  token: string;
  graph: string;
}

export interface Hosts {
  google: GoogleHosts;
  microsoft: MicrosoftHosts;
}

export const REAL_HOSTS: Hosts = {
  google: {
    auth: 'https://accounts.google.com/o/oauth2/v2/auth',
    revoke: 'https://oauth2.googleapis.com/revoke',
    api: 'https://www.googleapis.com/drive/v3',
    upload: 'https://www.googleapis.com/upload/drive/v3',
  },
  microsoft: {
    // "common" lets work, school and personal accounts sign in.
    auth: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    graph: 'https://graph.microsoft.com/v1.0',
  },
};

/** The fake providers' addresses under one local base. Only the test build uses this. */
export function fakeHosts(base: string): Hosts {
  return {
    google: {
      auth: `${base}/google/auth`,
      revoke: `${base}/google/revoke`,
      api: `${base}/google/drive/v3`,
      upload: `${base}/google/upload/drive/v3`,
    },
    microsoft: {
      auth: `${base}/ms/authorize`,
      token: `${base}/ms/token`,
      graph: `${base}/graph/v1.0`,
    },
  };
}

/** The address prefixes the code may fetch for one provider. */
export const fetchable = (h: Hosts, p: 'google' | 'microsoft'): string[] =>
  p === 'google' ? [h.google.revoke, h.google.api, h.google.upload] : [h.microsoft.token, h.microsoft.graph];
