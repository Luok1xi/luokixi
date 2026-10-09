// Alternate constraint direction so a pointer impulse propagates towards the
// pinned roof as well as the free end. The final unilateral limit allows a little
// stretch without a long strand gaining length on every gravity step.
export function constrainStrand(nodes, rest) {
  const count = nodes.length;
  for (let pass=0;pass<4;pass++) {
    const forward = pass%2===0;
    for (let step=1;step<count;step++) {
      const i = forward?step:count-step, a=nodes[i-1], b=nodes[i];
      const dx=b.x-a.x,dy=b.y-a.y,d=Math.sqrt(dx*dx+dy*dy)||.001;
      const error=(d-rest[i])/d;
      if (i===1) {b.x-=dx*error;b.y-=dy*error;}
      else {const x=dx*error*.5,y=dy*error*.5;a.x+=x;a.y+=y;b.x-=x;b.y-=y;}
    }
  }
  for (let i=1;i<count;i++) {
    const a=nodes[i-1],b=nodes[i],dx=b.x-a.x,dy=b.y-a.y;
    const square=dx*dx+dy*dy,limit=rest[i]*1.025;
    if(square>limit*limit) {const ratio=limit/Math.sqrt(square);b.x=a.x+dx*ratio;b.y=a.y+dy*ratio;}
  }
}

export function pointerImpulse(previous, distance) {
  return Math.max(-20,Math.min(20,previous*.5+distance));
}
