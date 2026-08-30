import {money} from "../../lib/api";

export function Metric({label,value,note,moneyValue=false}:{label:string;value:any;note:string;moneyValue?:boolean}){const shown=value===null||value===undefined?"—":moneyValue?money(value):value;return <div className="stat-card"><span>{label}</span><b>{shown}</b><small>{note}</small></div>}
