import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SceneViewportView } from "./SceneViewport.js";
const scene = {sceneId:"s",campaignId:"c",backgroundFileId:"f",revision:3,fog:[],tokens:[{tokenId:"t",label:"Wren",x:.25,y:.5,size:.1,visible:true,imageFileId:null}]};
function setup() {
 class Pointer extends MouseEvent {pointerId=1;pointerType:string;isPrimary=true;constructor(type:string,init:PointerEventInit={}){super(type,init);this.pointerType=init.pointerType??"mouse";}}
 vi.stubGlobal("PointerEvent",Pointer);
 const brush={radius:.1,remaining:512,onStroke:vi.fn()}, interaction={mode:"brush",setMode:vi.fn(),disabled:false,onPlace:vi.fn(),onMove:vi.fn(),brush};
 const view=render(<SceneViewportView scene={scene} imageUrl="/bg" fog={{mode:"reveal",radius:.1,draft:[]} as never} interaction={interaction as never}/>);
 const layer=screen.getByTestId("scene-zoom-layer"),region=screen.getByRole("region",{name:/scene viewport/i});
 vi.spyOn(layer,"getBoundingClientRect").mockReturnValue({x:-50,y:20,left:-50,top:20,width:500,height:300,right:450,bottom:320,toJSON(){}});
 region.setPointerCapture=vi.fn();region.releasePointerCapture=vi.fn();region.hasPointerCapture=vi.fn().mockReturnValue(true);
 function pointer(type:"pointerDown"|"pointerMove"|"pointerUp"|"pointerCancel",x:number,y:number,pointerType="mouse",target:Element=region){fireEvent[type](target,{clientX:x,clientY:y,pointerId:1,pointerType,button:0});}
 return{...view,brush,interaction,region,pointer};
}
describe("on-scene fog brush",()=>{
 it.each(["mouse","touch"])("previews a normalized %s stroke without saving or moving tokens",type=>{
  const s=setup();s.pointer("pointerDown",75,170,type,screen.getByRole("button",{name:"Token Wren"}));s.pointer("pointerMove",325,170,type);
  expect(s.brush.onStroke).not.toHaveBeenCalled();expect(screen.getByTestId("fog-stroke-preview")).toBeInTheDocument();
  expect(screen.getByTestId("fog-brush-radius")).toHaveAttribute("r","0.1");
  s.pointer("pointerUp",325,170,type);expect(s.brush.onStroke).toHaveBeenCalledTimes(1);
  const dabs=s.brush.onStroke.mock.calls[0]![0];expect(dabs[0]).toEqual({x:.25,y:.5,r:.1});expect(dabs.at(-1)).toEqual({x:.75,y:.5,r:.1});
  expect(dabs.length).toBeGreaterThan(2);expect(s.interaction.onMove).not.toHaveBeenCalled();expect(s.interaction.onPlace).not.toHaveBeenCalled();
 });
 it.each(["Escape","pointerCancel","scroll"])("discards the active preview on %s",cancel=>{
  const s=setup();s.pointer("pointerDown",75,170);s.pointer("pointerMove",325,170);
  if(cancel==="Escape")fireEvent.keyDown(window,{key:"Escape"});else if(cancel==="scroll")fireEvent.scroll(window);else s.pointer("pointerCancel",325,170);
  s.pointer("pointerUp",325,170);expect(s.brush.onStroke).not.toHaveBeenCalled();expect(screen.queryByTestId("fog-stroke-preview")).toBeNull();
 });
 it("does not consume the sample budget with sub-radius pointer jitter",()=>{
  const s=setup();s.pointer("pointerDown",75,170);
  for(let i=1;i<=100;i++)s.pointer("pointerMove",75+(i%2),170);
  s.pointer("pointerUp",76,170);
  expect(s.brush.onStroke.mock.calls[0]![0].length).toBeLessThanOrEqual(3);
 });
 it("cancels active input when Reveal/Conceal changes",()=>{
  const s=setup();s.pointer("pointerDown",75,170);s.pointer("pointerMove",325,170);
  s.rerender(<SceneViewportView scene={scene} imageUrl="/bg" fog={{mode:"conceal",radius:.1,draft:[]} as never} interaction={{...s.interaction,brush:{...s.brush,mode:"conceal"}} as never}/>);
  s.pointer("pointerUp",325,170);expect(s.brush.onStroke).not.toHaveBeenCalled();
 });
 it("bounds interpolation and retains committed and draft fog as separate overlays",()=>{
  const s=setup();s.brush.remaining=4;s.pointer("pointerDown",75,170);s.pointer("pointerMove",450,320);s.pointer("pointerUp",450,320);
  expect(s.brush.onStroke.mock.calls[0]![0]).toHaveLength(4);
  s.rerender(<SceneViewportView scene={{...scene,fog:[{mode:"reveal",runs:[{x:.2,y:.3,r:.1}]}]}} imageUrl="/bg" fog={{mode:"conceal",radius:.2,draft:[{x:.7,y:.6,r:.2}]} as never} interaction={s.interaction as never}/>);
  expect(screen.getByTestId("fog-committed-mask")).toBeInTheDocument();expect(screen.getByTestId("fog-draft-overlay")).toHaveAttribute("data-mode","conceal");
 });
});
