'use strict';
/**
 * Small offline list of UK towns and cities (approximate centre points).
 * Used ONLY as a fallback when the online geocoding services cannot be
 * reached (for example during an offline demonstration). Results from this
 * list are labelled "offline" in the API response.
 */
module.exports = [
  ['Aberdeen', 'Scotland', 57.1497, -2.0943], ['Bath', 'Somerset', 51.3811, -2.3590],
  ['Belfast', 'Northern Ireland', 54.5973, -5.9301], ['Billingham', 'Stockton-on-Tees', 54.6070, -1.2900],
  ['Birmingham', 'West Midlands', 52.4862, -1.8904], ['Blackpool', 'Lancashire', 53.8175, -3.0357],
  ['Bournemouth', 'Dorset', 50.7192, -1.8808], ['Bradford', 'West Yorkshire', 53.7960, -1.7594],
  ['Brighton', 'East Sussex', 50.8225, -0.1372], ['Bristol', 'South West', 51.4545, -2.5879],
  ['Cambridge', 'Cambridgeshire', 52.2053, 0.1218], ['Canterbury', 'Kent', 51.2802, 1.0789],
  ['Cardiff', 'Wales', 51.4816, -3.1791], ['Carlisle', 'Cumbria', 54.8925, -2.9329],
  ['Coventry', 'West Midlands', 52.4068, -1.5197], ['Darlington', 'County Durham', 54.5236, -1.5595],
  ['Derby', 'Derbyshire', 52.9225, -1.4746], ['Doncaster', 'South Yorkshire', 53.5228, -1.1285],
  ['Dundee', 'Scotland', 56.4620, -2.9707], ['Durham', 'County Durham', 54.7753, -1.5849],
  ['Edinburgh', 'Scotland', 55.9533, -3.1883], ['Exeter', 'Devon', 50.7184, -3.5339],
  ['Gateshead', 'Tyne and Wear', 54.9526, -1.6034], ['Glasgow', 'Scotland', 55.8642, -4.2518],
  ['Gloucester', 'Gloucestershire', 51.8642, -2.2382], ['Guisborough', 'Redcar and Cleveland', 54.5350, -1.0560],
  ['Hartlepool', 'County Durham', 54.6863, -1.2129], ['Hull', 'East Riding of Yorkshire', 53.7676, -0.3274],
  ['Inverness', 'Scotland', 57.4778, -4.2247], ['Ipswich', 'Suffolk', 52.0567, 1.1482],
  ['Leeds', 'West Yorkshire', 53.8008, -1.5491], ['Leicester', 'Leicestershire', 52.6369, -1.1398],
  ['Lincoln', 'Lincolnshire', 53.2307, -0.5406], ['Liverpool', 'Merseyside', 53.4084, -2.9916],
  ['London', 'Greater London', 51.5072, -0.1276], ['Manchester', 'Greater Manchester', 53.4808, -2.2426],
  ['Middlesbrough', 'North Yorkshire', 54.5742, -1.2348], ['Milton Keynes', 'Buckinghamshire', 52.0406, -0.7594],
  ['Newcastle upon Tyne', 'Tyne and Wear', 54.9783, -1.6178], ['Northallerton', 'North Yorkshire', 54.3390, -1.4340],
  ['Northampton', 'Northamptonshire', 52.2405, -0.9027], ['Norwich', 'Norfolk', 52.6309, 1.2974],
  ['Nottingham', 'Nottinghamshire', 52.9548, -1.1581], ['Oxford', 'Oxfordshire', 51.7520, -1.2577],
  ['Peterborough', 'Cambridgeshire', 52.5695, -0.2405], ['Plymouth', 'Devon', 50.3755, -4.1427],
  ['Portsmouth', 'Hampshire', 50.8198, -1.0880], ['Preston', 'Lancashire', 53.7632, -2.7031],
  ['Reading', 'Berkshire', 51.4543, -0.9781], ['Redcar', 'Redcar and Cleveland', 54.6161, -1.0697],
  ['Sheffield', 'South Yorkshire', 53.3811, -1.4701], ['Southampton', 'Hampshire', 50.9097, -1.4044],
  ['Stockton-on-Tees', 'County Durham', 54.5705, -1.3187], ['Stoke-on-Trent', 'Staffordshire', 53.0027, -2.1794],
  ['Sunderland', 'Tyne and Wear', 54.9069, -1.3838], ['Swansea', 'Wales', 51.6214, -3.9436],
  ['Thornaby-on-Tees', 'Stockton-on-Tees', 54.5440, -1.3000], ['Wolverhampton', 'West Midlands', 52.5862, -2.1288],
  ['Whitby', 'North Yorkshire', 54.4858, -0.6206], ['Yarm', 'Stockton-on-Tees', 54.5090, -1.3570],
  ['York', 'North Yorkshire', 53.9600, -1.0873]
].map(([name, area, lat, lon]) => ({ name, area, lat, lon }));
