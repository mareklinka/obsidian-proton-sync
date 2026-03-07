export const en = {
  common: {
    cancel: 'Cancel'
  },
  commands: {
    pushVault: 'Push vault to Proton Drive',
    pullVault: 'Pull vault from Proton Drive'
  },
  ribbon: {
    openSyncActions: 'Proton Drive Sync'
  },
  main: {
    notices: {
      login: {
        credentialsRequired: 'Email and password are required to connect.',
        captchaDataNotProvided: 'Captcha data was not provided. Login aborted.',
        captchaRequired: 'Captcha is required to login. Login aborted.',
        twoFactorRequired: 'Two-factor code is required to login. Login aborted.',
        mailboxPasswordRequired: 'Mailbox password is required to login. Login aborted.',
        protonApiCommunicationFailed: (message: string) =>
          `Failed to communicate with Proton API: ${message}. Login aborted.`
      },
      invalidFolderName: 'Invalid folder name.',
      folderAlreadyExists: 'Folder already exists.',
      myFilesRootNotFound: 'The "My Files" root folder was not found in Proton Drive.',
      setupVaultRootFailed:
        'An error occurred while setting up the vault root folder in Proton Drive. Please try again later.',
      protonApiError: 'Failed to communicate with Proton API.',
      ambiguousSharedPath: 'The specified shared folder path is ambiguous.',
      sharedFolderNotFound: 'The specified shared folder was not found.',
      invalidSharedPath: 'The specified shared folder path is invalid.',
      treeSubscriptionFailed:
        'Failed to subscribe to remote file tree updates. Remote changes may not be detected until you restart Obsidian.',
      disconnected: 'Disconnected from Proton Drive.'
    }
  },
  actions: {
    notices: {
      pushingStarted: 'Pushing vault to Proton Drive...',
      pushCompleted: 'Push completed.',
      pullStarted: 'Pulling vault data from Proton Drive...',
      pullCompleted: 'Pull completed.',
      signInRequired: 'Please sign in to Proton Drive before syncing.',
      sessionActivationFailed: 'Saved session could not be activated. Please sign in again.',
      syncCancelled: 'Sync cancelled.',
      syncAlreadyInProgress: 'A sync is already in progress. Please wait for it to complete.',
      vaultRootUnavailable: 'Vault root ID is not available. Please ensure your Proton account is connected correctly.',
      permissionError:
        'You do not have permission to perform this action. Please check your Proton Drive folder permissions.',
      pushFailed: 'Push failed. Please try again.',
      pullFailed: 'Pull failed. Please try again.'
    },
    confirmation: {
      pushTitle: 'Push vault to Proton Drive',
      pullTitle: 'Pull vault from Proton Drive',
      pushLabel: 'Push',
      pullLabel: 'Pull',
      pruneRemoteLabel: 'Prune remote vault',
      pruneLocalLabel: 'Prune local vault',
      pruneRemoteDescription: 'This will remove all remote files not present locally.',
      pruneLocalDescription: 'This will remove all local files not present in Proton Drive.'
    }
  },
  statusBar: {
    prefix: 'Proton Drive Sync:',
    titles: {
      idle: 'Idle',
      pulling: 'Pull in progress',
      pushing: 'Push in progress',
      auth: 'Authentication in progress'
    }
  },
  auth: {
    labels: {
      connected: 'Connected',
      connecting: 'Connecting',
      error: 'Error',
      disconnected: 'Disconnected'
    }
  },
  settings: {
    title: 'Proton Drive Sync',
    disclaimerTitle: '⚠️ Disclaimer',
    disclaimerBody: 'This plugin is an unofficial, third-party integration with Proton Drive.',
    disclosureCredentials:
      'You will be asked to enter your credentials into this plugin. Passwords or other sensitive information are never stored or logged.',
    connectionStatus: {
      name: 'Connection status',
      connectButton: 'Connect',
      connectingButton: 'Connecting...',
      disconnectButton: 'Disconnect'
    },
    remoteVaultRoot: {
      name: 'Remote vault root',
      description1: 'The root folder in Proton Drive where your vault will be synced.',
      description2: 'To use a folder shared with you, use the format:',
      description3: '$shared$/[shared folder name]/[rest of path]',
      placeholder: 'e.g. obsidian-notes/my-vault'
    },
    logLevel: {
      name: 'Log level',
      description: 'Minimum log severity to write to the developer console.',
      options: {
        debug: 'Debug',
        info: 'Info',
        warn: 'Warn',
        error: 'Error'
      }
    },
    ignoredPaths: {
      name: 'Ignored paths',
      description: 'One glob pattern per line. Paths are relative to vault root and ignored by both push and pull.',
      placeholder: '.obsidian/workspace*\ntemplates/**\n**/*.tmp'
    },
    statusLabels: {
      status: 'Status',
      account: 'Account',
      lastLogin: 'Last login',
      lastRefresh: 'Last refresh',
      expires: 'Expires',
      error: 'Error'
    }
  },
  modals: {
    shared: {
      credentialsDisclosure: '⚠️ Your credentials are never stored or logged.'
    },
    login: {
      title: 'Connect to Proton Drive',
      emailName: 'Email',
      emailDescription: 'Your Proton account email address.',
      emailPlaceholder: 'john.shepard@proton.me',
      passwordName: 'Password',
      passwordDescription: 'Never stored. Used only for this login attempt.',
      submit: 'Connect'
    },
    twoFactor: {
      title: 'Two-factor authentication required',
      codeName: '2FA code',
      codeDescription: 'Enter the current code from your authenticator app.',
      codePlaceholder: '123456',
      submit: 'Submit'
    },
    mailboxPassword: {
      title: 'Mailbox password required',
      passwordName: 'Mailbox password',
      passwordDescription: 'Required for Proton accounts that use a separate mailbox password.',
      submit: 'Submit'
    },
    captcha: {
      title: 'CAPTCHA verification required',
      help: 'Solve the CAPTCHA challenge. The dialog will close automatically once the challenge is successfully completed.',
      iframeTitle: 'Proton CAPTCHA challenge',
      reload: 'Reload CAPTCHA'
    },
    syncAction: {
      title: 'Proton Drive Sync',
      description:
        'Choose whether to push your local vault data to Proton Drive, or pull remote data to local. This operation synchronizes both notes and vault configuration.',
      pushButton: 'Push',
      pullButton: 'Pull'
    },
    syncProgress: {
      title: 'Proton Drive Sync',
      initialMessage: 'No sync operations are currently running.',
      initialDetails: '',
      cancellingMessage: 'Cancelling...',
      cancellingDetails: 'Waiting for the current operation to complete.',
      cancelledMessage: 'Operation cancelled.',
      closeHint: 'You can close this dialog at any time. The sync will continue in the background.',
      completedMessage: 'Operation complete.',
      failedMessage: 'Operation failed.',
      autoCloseMessage: (secondsRemaining: number) =>
        `All changes have been processed. This dialog will close in ${secondsRemaining} ${secondsRemaining === 1 ? 'second' : 'seconds'}.`
    },
    confirm: {
      cancelTooltip: 'Cancel'
    }
  },
  syncProgressState: {
    idle: {
      message: 'No sync operations are currently running.',
      details: ''
    },
    localTreeBuild: {
      message: 'Scanning local files...',
      details: 'Building local file tree.'
    },
    remoteTreeBuild: {
      message: 'Scanning remote files...',
      details: 'Building remote file tree.'
    },
    diffComputation: {
      message: 'Comparing files...',
      details: 'Determining files to synchronize.'
    },
    applyingChanges: {
      downloading: 'Downloading notes...',
      uploading: 'Uploading notes...',
      details: (processed: number, total: number) => `Processed ${processed} of ${total} items.`
    },
    fallback: {
      message: 'Synchronizing...'
    }
  }
};

export type TranslationCatalog = typeof en;
