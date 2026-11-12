import { ReactCompareSlider, ReactCompareSliderImage } from "react-compare-slider";

export interface CompareSliderProps {
  readonly before: string;
  readonly after: string;
  readonly beforeLabel: string;
  readonly afterLabel: string;
}

export default function CompareSlider({ before, after, beforeLabel, afterLabel }: CompareSliderProps) {
  return (
    <div className="pd-compare__stage">
      <ReactCompareSlider
        itemOne={<ReactCompareSliderImage src={before} alt={beforeLabel} />}
        itemTwo={<ReactCompareSliderImage src={after} alt={afterLabel} />}
      />
      <span className="pd-compare__label pd-compare__label--before">{beforeLabel}</span>
      <span className="pd-compare__label pd-compare__label--after">{afterLabel}</span>
    </div>
  );
}
