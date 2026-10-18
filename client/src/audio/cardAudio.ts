/**
 * Word pronunciation over mp-client's card audio resolver. The server says per word whether
 * the player owns a card for it (`cardId`) or it should be spoken by text (`text` + `lang`);
 * the platform resolves either to one playable clip, so the game never touches storage URLs
 * or tokens itself.
 */
import { createCardAudio, type CardAudioClient, type GameSession } from '@memdecks/mp-client';
import type { AudioRef } from '../types';

export class WordAudio {
  private readonly client: CardAudioClient;

  constructor(session: GameSession) {
    this.client = createCardAudio(session);
  }

  async play(ref?: AudioRef): Promise<void> {
    if (!ref) return;
    try {
      await this.client.play('cardId' in ref ? ref.cardId : ref);
    } catch (error) {
      console.warn('Could not play word audio.', error);
    }
  }

  stop() {
    this.client.stop();
  }

  dispose() {
    this.client.stop();
    this.client.clear();
  }
}
