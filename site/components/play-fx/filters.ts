// Fragment stage of the existing screen-blended ShaderGuide. u_patch = (program, width, height).
export const filterGLSL = `
  if (u_patch.x > 0.5) {
    vec2 st = uv / u_patch.yz, cursor = u_mouse / u_patch.yz;
    vec2 p = (st-vec2(0.5)) * vec2(u_patch.y/u_patch.z,1.0);
    vec2 delta = (st-mix(vec2(0.5),cursor,0.42))*vec2(u_patch.y/u_patch.z,1.0);
    float t=u_time;
    if (u_patch.x < 1.5) {
      for (int k=0;k<3;k++) {
        float f=float(k), h=0.50+0.15*sin(st.x*5.0+t*.45+f*.8)+.07*sin(st.x*11.0+cursor.x*3.0+t*.23);
        float sheet=exp(-abs(st.y-h-f*.034)*10.0)*(.43+.30*sin(st.x*64.0+sin(st.x*22.0+t)*2.0+f));
        col+=sheet*mix(vec3(.04,.69,.4),vec3(.53,.10,.80),f*.5);
      }
    } else if (u_patch.x < 2.5) {
      float a=atan(delta.y,delta.x)+t*.12, r=max(.015,length(delta));
      float hex=r*cos(mod(a,1.0472)-.5236);
      float band=fract(-log(max(hex,.015))*2.2+t*.40);
      col+=exp(-abs(band-.52)*11.0)*(.52+.46*cos(log(r)*3.0+vec3(0.0,2.1,4.2)))*smoothstep(.015,.07,r)*.83;
    } else if (u_patch.x < 3.5) {
      float h=.37+cursor.y*.09, depth=h-st.y; vec2 sun=(st-vec2(.35+.30*cursor.x,h+.125))*vec2(u_patch.y/u_patch.z,1.0);
      float disc=1.0-smoothstep(.118,.123,length(sun));
      col+=disc*mix(vec3(.99,.15,.39),vec3(1.,.77,.22),clamp(sun.y*4.+.5,0.,1.))*(.25+.53*smoothstep(.14,.3,fract(st.y*70.)));
      if (depth>.01) { vec2 sq=vec2((p.x-(cursor.x-.5)*.18)/depth, .65/depth-t*.58); vec2 grid=abs(fract(sq)-.5); col+=exp(-min(grid.x,grid.y)*20.)*vec3(.85,.12,.60)*smoothstep(.012,.1,depth)*.67; }
    } else if (u_patch.x < 4.5) {
      float beam=.5+.40*sin(t*.73+cursor.y*2.0); float screen=exp(-abs(st.y-beam)*11.0);
      col=mix(col,vec3(.21,.99,.40)*dot(col,vec3(.38,.47,.15)),.78)+vec3(.06,.53,.12)*(.07+screen*.44)*(.54+.46*cos(uv.y/u_px*2.09));
      col+=exp(-abs(length(delta)-.18)*85.)*vec3(.14,.53,.20);
    } else {
      float v=sin(10.*p.x+3.8*sin(p.y*6.5+t*.6)+cursor.x*3.)+sin(8.*p.y-t*.68+2.4*cos(5.*p.x+t*.4));
      float vein=exp(-abs(v)*5.)+.49*exp(-abs(v-.32)*11.);
      col+=vein*mix(vec3(.14,.32,.56),vec3(.76,.92,1.),smoothstep(-.3,.6,p.y+.38))*.87;
    }
  }
`;
