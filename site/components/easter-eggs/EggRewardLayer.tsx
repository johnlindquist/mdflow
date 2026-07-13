import React from 'react';
import { eggDefinition, type EggId } from './catalog';

export type EggRewardId = EggId | 'puzzle-star' | 'factory-finale';

export interface EggReward {
  key: number;
  id: EggRewardId;
  text: string;
  point?: { x: number; y: number };
  seed?: number;
  escalated?: boolean;
}

const atPoint = (reward: EggReward): React.CSSProperties | undefined => reward.point
  ? { left: reward.point.x, top: reward.point.y }
  : undefined;

const animatedReward = (reward: EggReward) => {
  switch (reward.id) {
    case 'konami':
      return <div className="egg-terminal-panel egg-animated-reward"><span>$ md --god-mode</span><strong>GOD MODE COMPILED</strong><small>play shield · 5 seconds · guardrails unchanged</small></div>;
    case 'type-mdflow':
      return <div className="egg-reward-card egg-animated-reward">› › › <strong>mdflow</strong> · name resolved</div>;
    case 'type-egg':
      return <div className="egg-weather egg-animated-reward"><span>🥚</span><span>🥚</span><span>🥚</span><span className="egg-cracked">◒ clue inside</span></div>;
    case 'bass-drop':
      return <div className="egg-reward-card egg-animated-reward">▂▅▇ <strong>BASS</strong> ▇▅▂ · grid compressed</div>;
    case 'headline-hello':
      return <div className="egg-reward-card egg-animated-reward">HELLO, HUMAN.</div>;
    case 'eggo-dance':
      return <div className="egg-reward-card egg-animated-reward">EGGO.EXE · ← → ← → · choreography complete</div>;
    case 'alt-click':
      return <div className="egg-static-reward egg-gravity-indicator">↑ GRAVITY −1g ↑</div>;
    case 'click-cadence':
      return <div className="egg-cadence egg-animated-reward" style={atPoint(reward)}><i /><i />{reward.escalated && <><b>#</b><b>*</b><b>`flow`</b><b>&gt;</b></>}</div>;
    case 'corners':
      return <div className="egg-corner-frame egg-animated-reward"><span>✦ FRAME SIGNED ✦</span></div>;
    case 'footer-zap':
      return <div className="egg-reward-card egg-animated-reward">⚡ CONNECTOR CHARGED · current travelled upward</div>;
    case 'version-badge':
      return <div className="egg-reward-card egg-animated-reward">MAJOR · MINOR · PATCH → RESOLVED</div>;
    case 'logo-disco':
      return <div className="egg-reward-card egg-animated-reward">▂▆█ mdflow █▆▂ · scoped equalizer</div>;
    case 'middle-click': {
      const point = reward.point ?? { x: window.innerWidth * .2, y: window.innerHeight * .4 };
      return <><i className="egg-portal egg-animated-reward" style={{ left: point.x, top: point.y }} /><i className="egg-portal egg-portal-b egg-animated-reward" /><span className="egg-portal-spark egg-animated-reward" /></>;
    }
    case 'shake':
      return <div className="egg-reward-card egg-animated-reward"><strong>#</strong> · one markdown glyph shook loose</div>;
    case 'circle':
      return <div className="egg-orbit egg-animated-reward" style={atPoint(reward)}><span>✦</span></div>;
    case 'overload':
      return <div className="egg-reward-card egg-breaker egg-animated-reward"><span>CIRCUIT BREAKER</span><strong>CHARGE 117%</strong><small>tripped safely</small></div>;
    case 'monster-hunt':
      return <div className="egg-reward-card egg-monster-jar egg-animated-reward"><span>▞▚</span><div><strong>SPECIMEN VOICE CAPTURED</strong><br /><small>seed {reward.seed?.toFixed(3) ?? 'local'}</small></div></div>;
    case 'egg-pop':
      return <div className="egg-reward-card egg-fortune egg-animated-reward"><strong>🥚 crack · fortune #{Math.floor((reward.seed ?? .618) * 997) % 97}</strong><span>Small flows open large doors.</span></div>;
    case 'idle-fireflies':
      return <div className="egg-fireflies egg-animated-reward"><i /><i /><i /><i /><strong>md</strong></div>;
    case 'elevator':
      return <div className="egg-reward-card egg-elevator egg-animated-reward"><span>B</span><span>↑</span><strong>TOP</strong></div>;
    case 'shy-volume':
      return <div className="egg-reward-card egg-animated-reward">🔊 <q>okay, okay.</q></div>;
    case 'welcome-back':
      return <div className="egg-reward-card egg-postcard egg-animated-reward"><small>POSTCARD FROM THE TAB</small><strong>SIGNAL RESTORED</strong><span>We kept your place.</span></div>;
    case 'puzzle-star':
      return <div className="egg-reward-card egg-star-card">{reward.text}</div>;
    case 'factory-finale':
      return <div className="egg-reward-card egg-factory-finale"><strong>🏭⚡ THE FACTORY IS AWAKE</strong><span>All five proofs banked.</span><small>Eggo is golden forever.</small></div>;
  }
};

export const EggRewardLayer: React.FC<{ reward: EggReward | null; reducedMotion: boolean }> = ({ reward, reducedMotion }) => (
  <div className={reducedMotion ? 'egg-reward-layer egg-reduced' : 'egg-reward-layer'} aria-hidden="true">
    {reward && (reducedMotion ? (
      <div key={reward.key} className="egg-static-reward">
        {reward.id === 'puzzle-star' || reward.id === 'factory-finale'
          ? reward.text
          : eggDefinition(reward.id).reducedMotionText}
      </div>
    ) : <React.Fragment key={reward.key}>{animatedReward(reward)}</React.Fragment>)}
  </div>
);
