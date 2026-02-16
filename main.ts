import { Notice, Plugin } from 'obsidian';

export default class ProtonDriveSyncPlugin extends Plugin {
  async onload(): Promise<void> {
    console.log('Loading Proton Drive Sync plugin');

    this.addRibbonIcon('refresh-ccw', 'Proton Drive Sync', () => {
      new Notice('Proton Drive Sync: scaffold loaded');
    });
  }

  async onunload(): Promise<void> {
    console.log('Unloading Proton Drive Sync plugin');
  }
}
