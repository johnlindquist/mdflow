export const rooms = [
  { id: 'radio', tag: 'RX', name: 'Shortwave', task: 'Tune the dial. Listen between the stations.', accent: '#83e4bc' },
  { id: 'post', tag: 'PT', name: 'Tube post', task: 'Two stamps make an address. Send the capsule.', accent: '#fdba74' },
  { id: 'organ', tag: 'VO', name: 'Scrap organ', task: 'Three notes wake whatever lives in the pipes.', accent: '#c4b5fd' },
  { id: 'sky', tag: 'LP', name: 'Star press', task: 'Light the pins, then expose a plate of the night sky.', accent: '#8ed7ff' },
  { id: 'lost', tag: 'LF', name: 'Lost property', task: 'Read the claim ticket. Return the right object.', accent: '#fda4af' },
] as const;
export type Room = typeof rooms[number]['id'];
export const isRoom = (s: unknown): s is Room => rooms.some(room => room.id === s);
export const door = (room: Room) => `#night-shift/${room}`;
export const roomForHash = (hash: string) => rooms.find(room => door(room.id) === hash)?.id;
